/**
 * Filters, sort and search live in the URL so a view can be shared, bookmarked and restored.
 * Values equal to their default are omitted; unknown or invalid values fall back to the default.
 */
export interface UrlField<T> {
  parse(raw: string | null): T;
  /** `null` removes the key from the URL. Method syntax keeps schemas assignable to `UrlSchema`. */
  serialize(value: T): string | null;
}

export type UrlSchema = Readonly<Record<string, UrlField<unknown>>>;
export type UrlValues<S extends UrlSchema> = {
  [K in keyof S]: S[K] extends UrlField<infer T> ? T : never;
};

export function stringField(fallback = "", maxLength = 200): UrlField<string> {
  return {
    parse: (raw) => (raw === null ? fallback : raw.slice(0, maxLength)),
    serialize: (value) => (value === fallback || value === "" ? null : value),
  };
}

export function enumField<const V extends string>(allowed: readonly V[], fallback: V): UrlField<V> {
  return {
    parse: (raw) => allowed.find((value) => value === raw) ?? fallback,
    serialize: (value) => (value === fallback ? null : value),
  };
}

export function integerField(fallback: number, minimum: number, maximum: number): UrlField<number> {
  return {
    parse(raw) {
      if (raw === null || !/^-?\d{1,9}$/.test(raw)) return fallback;
      const value = Number(raw);
      return value >= minimum && value <= maximum ? value : fallback;
    },
    serialize: (value) => (value === fallback ? null : String(value)),
  };
}

export function readUrlState<S extends UrlSchema>(
  schema: S,
  params: URLSearchParams,
): UrlValues<S> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, field]) => [key, field.parse(params.get(key))]),
  ) as UrlValues<S>;
}

/** Applies `patch` to `params`, leaving keys outside the schema (for example `next`) untouched. */
export function writeUrlState<S extends UrlSchema>(
  schema: S,
  params: URLSearchParams,
  patch: Partial<UrlValues<S>>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    const field = schema[key];
    if (!field) throw new Error(`Unknown URL state key: ${key}`);
    const serialized = field.serialize(value);
    if (serialized === null) next.delete(key);
    else next.set(key, serialized);
  }
  return next;
}

/**
 * Post-login redirect targets must stay inside the portal: a single leading slash, no scheme,
 * no protocol-relative form, no backslash tricks, and never an API or login path.
 */
export function safeNext(raw: string | null): string | null {
  if (raw === null || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  // Control characters and whitespace are parsed away by browsers and can smuggle an origin.
  if ([...raw].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f))
    return null;
  const path = raw.split(/[?#]/, 1)[0] ?? "";
  if (/^\/(login|recover)(\/|$)/.test(path) || /^\/(v1|mcp)(\/|$)/.test(path)) return null;
  return raw;
}

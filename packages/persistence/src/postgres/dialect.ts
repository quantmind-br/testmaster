/**
 * SQLite-to-PostgreSQL dialect translation (ADR-015).
 *
 * Application code keeps writing SQLite-flavoured SQL. The PostgreSQL engine translates the closed
 * subset below and refuses everything else with `Unsupported SQL for PostgreSQL: <construct>`; a
 * construct is never passed through silently. The subset was inventoried by recording every
 * statement the unit suites execute (about 980 distinct statements) plus a static scan of the
 * source tree.
 *
 * Translated here:
 *   - positional `?` placeholders become `$1..$n`; a placeholder directly followed by
 *     `IS [NOT] NULL` is wrapped in `CAST($n AS TEXT)` because PostgreSQL cannot infer its type;
 *   - `AS mixedCaseAlias` is quoted so the result column keeps its case (SQLite preserves it);
 *   - `ifnull(a,b)` becomes `COALESCE(a,b)`;
 *   - `ORDER BY` terms get explicit `NULLS FIRST` (ascending) / `NULLS LAST` (descending) because
 *     SQLite sorts NULL as the smallest value while PostgreSQL sorts it as the largest.
 *
 * Provided by the schema instead of the translator (migration 0010 on PostgreSQL):
 *   `json_extract(doc, path)`, `json_type(doc, path)` and `instr(haystack, needle)` as SQL functions.
 *
 * Semantics that intentionally differ and are covered by the parity suite:
 *   - `LIKE` is case-sensitive on PostgreSQL; the application only matches lowercase key prefixes.
 *   - Text ordering follows the database collation; `openPostgres` refuses anything but a
 *     byte-order collation (`C`, `POSIX`, `C.UTF-8`) so ordering matches SQLite BINARY collation.
 *
 * Also translated: the exact expression `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (UTC clock, ISO-8601 with milliseconds).
 *
 * Refused (ContractError INTERNAL "Unsupported SQL for PostgreSQL: ..."): PRAGMA, sqlite_master,
 * sqlite_schema, INSERT OR REPLACE/IGNORE, REPLACE INTO, rowid, last_insert_rowid, strftime,
 * julianday, datetime, date, time, unixepoch, group_concat, total, printf, randomblob, zeroblob,
 * glob, typeof, changes, scalar max/min with several arguments, and named parameters.
 */
import { ContractError } from "@testmaster/contracts";

type TokenKind = "space" | "comment" | "string" | "quoted" | "param" | "word" | "number" | "punct";
interface Token {
  kind: TokenKind;
  text: string;
}

function unsupported(construct: string): never {
  throw new ContractError("INTERNAL", `Unsupported SQL for PostgreSQL: ${construct}`);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: TokenKind, end: number): void => {
    tokens.push({ kind, text: sql.slice(index, end) });
    index = end;
  };
  while (index < sql.length) {
    const char = sql[index] as string;
    if (/\s/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /\s/u.test(sql[end] as string)) end++;
      push("space", end);
    } else if (char === "-" && sql[index + 1] === "-") {
      let end = sql.indexOf("\n", index);
      if (end < 0) end = sql.length;
      push("comment", end);
    } else if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      push("comment", close < 0 ? sql.length : close + 2);
    } else if (char === "'" || char === '"') {
      let end = index + 1;
      for (;;) {
        if (end >= sql.length) unsupported("unterminated quoted text");
        if (sql[end] === char) {
          if (sql[end + 1] === char) end += 2;
          else break;
        } else end++;
      }
      push(char === "'" ? "string" : "quoted", end + 1);
    } else if (char === "$" && /^\$[A-Za-z_]*\$/u.test(sql.slice(index, index + 64))) {
      const tag = (/^\$[A-Za-z_]*\$/u.exec(sql.slice(index, index + 64)) as RegExpExecArray)[0];
      const close = sql.indexOf(tag, index + tag.length);
      if (close < 0) unsupported("unterminated dollar-quoted text");
      push("string", close + tag.length);
    } else if (char === "?") {
      if (/[0-9]/u.test(sql[index + 1] ?? "")) unsupported("numbered parameter");
      push("param", index + 1);
    } else if (
      (char === ":" || char === "@" || char === "$") &&
      /[A-Za-z_]/u.test(sql[index + 1] ?? "")
    ) {
      // `::` casts and `a:b` inside strings never reach here; a bare `:name` is a named parameter.
      if (char === ":" && sql[index - 1] === ":") push("punct", index + 1);
      else unsupported("named parameter");
    } else if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end] as string)) end++;
      push("word", end);
    } else if (/[0-9]/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[0-9A-Za-z_.]/u.test(sql[end] as string)) end++;
      push("number", end);
    } else push("punct", index + 1);
  }
  return tokens;
}

const refusedWords: Record<string, true> = {
  pragma: true,
  sqlite_master: true,
  sqlite_schema: true,
  sqlite_sequence: true,
  sqlite_temp_master: true,
  rowid: true,
  oid: true,
  last_insert_rowid: true,
  glob: true,
};
const refusedFunctions: Record<string, true> = {
  strftime: true,
  julianday: true,
  datetime: true,
  date: true,
  time: true,
  unixepoch: true,
  group_concat: true,
  total: true,
  printf: true,
  randomblob: true,
  zeroblob: true,
  typeof: true,
  changes: true,
  load_extension: true,
};
const orderTerminators: Record<string, true> = {
  limit: true,
  offset: true,
  fetch: true,
  union: true,
  except: true,
  intersect: true,
  for: true,
};

const significant = (tokens: readonly Token[], from: number, step: 1 | -1): number => {
  let index = from;
  while (index >= 0 && index < tokens.length) {
    const kind = (tokens[index] as Token).kind;
    if (kind !== "space" && kind !== "comment") return index;
    index += step;
  }
  return -1;
};

const lower = (token: Token | undefined): string =>
  token?.kind === "word" ? token.text.toLowerCase() : "";

/** Index of the `)` that closes the call whose `(` is at `open`. */
function callEnd(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind !== "punct") continue;
    if (token.text === "(") depth++;
    else if (token.text === ")" && --depth === 0) return index;
  }
  return unsupported("unbalanced parentheses");
}

function scalarMinMax(tokens: readonly Token[], open: number): boolean {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind !== "punct") continue;
    if (token.text === "(") depth++;
    else if (token.text === ")") {
      depth--;
      if (depth === 0) return false;
    } else if (token.text === "," && depth === 1) return true;
  }
  return false;
}

/** Appends `NULLS FIRST|LAST` to every top-level ORDER BY term that has no explicit null ordering. */
function orderNulls(tokens: Token[]): void {
  const insertions: number[][] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (lower(tokens[index]) !== "order") continue;
    const by = significant(tokens, index + 1, 1);
    if (lower(tokens[by]) !== "by") continue;
    let depth = 0;
    let termStart = by + 1;
    let cursor = by + 1;
    const closeTerm = (end: number): void => {
      const last = significant(tokens, end - 1, -1);
      if (last < termStart) return;
      for (let probe = termStart; probe <= last; probe++)
        if (lower(tokens[probe]) === "nulls") return;
      insertions.push([last + 1, lower(tokens[last]) === "desc" ? 1 : 0]);
    };
    for (; cursor < tokens.length; cursor++) {
      const token = tokens[cursor] as Token;
      if (token.kind === "punct") {
        if (token.text === "(") depth++;
        else if (token.text === ")") {
          if (depth === 0) break;
          depth--;
        } else if (token.text === ";" && depth === 0) break;
        else if (token.text === "," && depth === 0) {
          closeTerm(cursor);
          termStart = cursor + 1;
        }
      } else if (depth === 0 && Object.hasOwn(orderTerminators, lower(token))) break;
    }
    closeTerm(cursor);
    index = cursor;
  }
  for (const [at, descending] of insertions.reverse() as Array<[number, number]>)
    tokens.splice(at, 0, { kind: "word", text: descending ? " NULLS LAST" : " NULLS FIRST" });
}

export interface TranslatedSql {
  sql: string;
  /** Number of `?` placeholders translated. */
  parameters: number;
}

const cache = new Map<string, TranslatedSql>();

/** Translates one SQLite-flavoured statement to PostgreSQL, or throws for unsupported constructs. */
export function translateSql(sql: string): TranslatedSql {
  const cached = cache.get(sql);
  if (cached) return cached;
  const tokens = tokenize(sql);
  const first = lower(tokens[significant(tokens, 0, 1)]);
  if (first === "pragma") unsupported("PRAGMA");
  if (first === "replace") unsupported("REPLACE INTO");
  let parameters = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind === "param") {
      parameters++;
      const next = significant(tokens, index + 1, 1);
      let after = next;
      if (lower(tokens[after]) === "is") {
        after = significant(tokens, after + 1, 1);
        if (lower(tokens[after]) === "not") after = significant(tokens, after + 1, 1);
        if (lower(tokens[after]) === "null") {
          token.text = `CAST($${parameters} AS TEXT)`;
          continue;
        }
      }
      token.text = `$${parameters}`;
      continue;
    }
    if (token.kind !== "word") continue;
    const word = token.text.toLowerCase();
    if (Object.hasOwn(refusedWords, word)) unsupported(token.text);
    const prevIndex = significant(tokens, index - 1, -1);
    const previous = lower(tokens[prevIndex]);
    if (
      word === "or" &&
      (previous === "insert" || previous === "update" || previous === "delete")
    ) {
      const nextWord = lower(tokens[significant(tokens, index + 1, 1)]);
      if (
        nextWord === "replace" ||
        nextWord === "ignore" ||
        nextWord === "abort" ||
        nextWord === "fail"
      )
        unsupported(`${previous.toUpperCase()} OR ${nextWord.toUpperCase()}`);
    }
    const nextIndex = significant(tokens, index + 1, 1);
    const isCall = (tokens[nextIndex] as Token | undefined)?.text === "(";
    if (isCall && previous !== ".") {
      if (word === "strftime") {
        const close = callEnd(tokens, nextIndex);
        const call = tokens
          .slice(index, close + 1)
          .map((item) => item.text)
          .join("")
          .replace(/\s+/gu, "");
        if (call === "strftime('%Y-%m-%dT%H:%M:%fZ','now')") {
          // The one clock expression the application uses: UTC ISO-8601 with milliseconds.
          token.text = `to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
          tokens.splice(index + 1, close - index);
          continue;
        }
      }
      if (Object.hasOwn(refusedFunctions, word)) unsupported(`${word}()`);
      if (word === "ifnull") token.text = "COALESCE";
      if ((word === "max" || word === "min") && scalarMinMax(tokens, nextIndex))
        unsupported(`scalar ${word}() with several arguments`);
    }
    if (word === "as") {
      const aliasIndex = significant(tokens, index + 1, 1);
      const alias = tokens[aliasIndex];
      if (alias?.kind === "word" && /[a-z]/u.test(alias.text) && /[A-Z]/u.test(alias.text))
        alias.text = `"${alias.text}"`;
    }
  }
  orderNulls(tokens);
  const translated = { sql: tokens.map((token) => token.text).join(""), parameters };
  if (cache.size > 4096) cache.clear();
  cache.set(sql, translated);
  return translated;
}

/** Splits a script into statements at top-level semicolons (outside strings, quotes and comments). */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current: Token[] = [];
  for (const token of tokenize(script)) {
    if (token.kind === "punct" && token.text === ";") {
      const text = current
        .map((item) => item.text)
        .join("")
        .trim();
      if (text) statements.push(text);
      current = [];
    } else current.push(token);
  }
  const text = current
    .map((item) => item.text)
    .join("")
    .trim();
  if (text) statements.push(text);
  return statements.filter((statement) =>
    /[^\s]/u.test(statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, "")),
  );
}

/** True for statements that cannot modify data, so they need neither the writer lock nor a savepoint. */
export function isReadStatement(sql: string): boolean {
  const first = lower(tokenize(sql).find((token) => token.kind === "word"));
  return first === "select" || first === "values" || first === "show" || first === "explain";
}

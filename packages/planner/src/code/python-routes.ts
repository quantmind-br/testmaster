import type { PythonCodeSummary, PythonRouter } from "./types.js";

type PythonFile = PythonCodeSummary["files"][number];
type PythonFunction = PythonFile["functions"][number];
type PythonImport = PythonFile["imports"][number];

export interface PythonEndpoint {
  framework: "fastapi" | "flask";
  method: string;
  path: string;
  handler: string;
  line: number;
  file: string;
}
export interface PythonRouteResolution {
  endpoints: PythonEndpoint[];
  warnings: { path: string; code: string; message: string }[];
}
type Definition =
  | { file: PythonFile; router: PythonRouter }
  | { file: PythonFile; function: PythonFunction };
interface Mount {
  /** Every full prefix a router is served under that could be resolved. */
  prefixes: Set<string>;
  /** Some way of mounting the router has a prefix that is not a literal, or loops. */
  unresolved: boolean;
  /** The router is reachable from a FastAPI application found in the analyzed files. */
  mounted: boolean;
}
interface Edge {
  parent: string;
  /** The `prefix=` of the include (or the mount path); null when it is not a literal. */
  prefix: string | null;
}

const routerKey = (path: string, id: number): string => `${path}#${id}`;
function moduleSegments(path: string): string[] {
  const segments = path.replace(/\.py$/u, "").split("/");
  if (segments.at(-1) === "__init__") segments.pop();
  return segments;
}
function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}${path}`;
  return joined === "" ? "/" : joined;
}

/** Maps dotted module names (as written in imports) onto the analyzed files, without importing anything. */
class ModuleIndex {
  private readonly byPath = new Map<string, PythonFile>();
  private readonly bySuffix = new Map<string, PythonFile[]>();
  constructor(files: readonly PythonFile[]) {
    for (const file of files) {
      this.byPath.set(file.path, file);
      const segments = moduleSegments(file.path);
      for (let start = 0; start < segments.length; start += 1) {
        const suffix = segments.slice(start).join(".");
        const known = this.bySuffix.get(suffix);
        if (known) known.push(file);
        else this.bySuffix.set(suffix, [file]);
      }
    }
  }
  /** The file a dotted module names; null when it is not among the analyzed files or is ambiguous. */
  resolve(from: string, module: string, level: number): PythonFile | null {
    return level > 0 ? this.relative(from, module, level) : this.absolute(module);
  }
  /** `a.b` finds `a/b.py`, `a/b/__init__.py`, or the same under a source root (`src/a/b.py`). */
  private absolute(module: string): PythonFile | null {
    const candidates = this.bySuffix.get(module) ?? [];
    if (candidates.length === 1) return candidates[0] ?? null;
    return candidates.find((file) => moduleSegments(file.path).join(".") === module) ?? null;
  }
  private relative(from: string, module: string, level: number): PythonFile | null {
    const directory = from.split("/").slice(0, -1);
    if (level - 1 > directory.length) return null;
    const segments = [
      ...directory.slice(0, directory.length - (level - 1)),
      ...(module ? module.split(".") : []),
    ];
    return (
      this.byPath.get(`${segments.join("/")}.py`) ??
      this.byPath.get([...segments, "__init__.py"].join("/")) ??
      null
    );
  }
}

/** Finds what a (dotted) name written in a file stands for: a module-level router or function, possibly imported. */
function definitionFinder(
  modules: ModuleIndex,
): (file: PythonFile, name: string) => Definition | null {
  const find = (file: PythonFile, parts: string[], seen: Set<string>): Definition | null => {
    const marker = `${file.path}:${parts.join(".")}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const [head, ...rest] = parts;
    if (head === undefined) return null;
    if (rest.length === 0) {
      const router = file.routers.find(
        (item) => item.module && item.kind !== "parameter" && item.name === head,
      );
      if (router) return { file, router };
      const declared = file.functions.find((item) => item.name === head);
      if (declared) return { file, function: declared };
    }
    const imported: PythonImport | undefined = file.imports.find((item) => item.local === head);
    if (!imported) return null;
    if (rest.length === 0) {
      if (imported.name === null) return null;
      const target = modules.resolve(file.path, imported.module, imported.level);
      return target ? find(target, [imported.name], seen) : null;
    }
    // `module.symbol`, `package.module.symbol`, or `submodule.symbol` after `from package import submodule`.
    const symbol = rest.at(-1) as string;
    const between = rest.slice(0, -1);
    const base =
      imported.name === null
        ? [imported.module, ...between]
        : [...(imported.module ? [imported.module] : []), imported.name, ...between];
    const target = modules.resolve(file.path, base.join("."), imported.level);
    return target ? find(target, [symbol], seen) : null;
  };
  return (file, name) => find(file, name.split("."), new Set());
}

/**
 * The routes of FastAPI files with the prefixes of the routers they are mounted under. A route's full path is
 * `<parent prefix><include prefix><router prefix><decorator path>` along every chain of `include_router`/`mount`
 * calls and router-passing calls that reaches it, followed across modules through static imports. A prefix that is
 * not a literal is never guessed: the route keeps the path it declares (with the router's own literal prefix) and a
 * warning names the router.
 */
export function resolvePythonRoutes(files: readonly PythonFile[]): PythonRouteResolution {
  const find = definitionFinder(new ModuleIndex(files));
  const routers = new Map<string, PythonRouter>();
  const routerFiles = new Map<string, string>();
  const incoming = new Map<string, Edge[]>();
  for (const file of files)
    for (const router of file.routers) {
      routers.set(routerKey(file.path, router.id), router);
      routerFiles.set(routerKey(file.path, router.id), file.path);
    }
  const connect = (child: string, edge: Edge): void => {
    const known = incoming.get(child);
    if (known) known.push(edge);
    else incoming.set(child, [edge]);
  };
  for (const file of files) {
    for (const include of file.includes) {
      const parent = routerKey(file.path, include.parent);
      if ("router" in include.child) {
        connect(routerKey(file.path, include.child.router), { parent, prefix: include.prefix });
        continue;
      }
      const definition = find(file, include.child.name);
      if (!definition) continue;
      if ("function" in definition) {
        if (include.child.call)
          for (const id of definition.function.returns)
            connect(routerKey(definition.file.path, id), { parent, prefix: include.prefix });
      } else if (!include.child.call)
        connect(routerKey(definition.file.path, definition.router.id), {
          parent,
          prefix: include.prefix,
        });
    }
    for (const call of file.calls) {
      const definition = find(file, call.callee);
      if (!definition || !("function" in definition)) continue;
      for (const argument of call.arguments) {
        const name = argument.keyword ?? definition.function.parameters[argument.index ?? -1];
        if (name === undefined || !Object.hasOwn(definition.function.routerParameters, name))
          continue;
        const id = definition.function.routerParameters[name] as number;
        connect(routerKey(definition.file.path, id), {
          parent: routerKey(file.path, argument.router),
          prefix: "",
        });
      }
    }
  }
  const mounts = new Map<string, Mount>();
  const mountOf = (key: string, active: Set<string>): Mount => {
    const known = mounts.get(key);
    const router = routers.get(key);
    if (known) return known;
    if (!router || active.has(key))
      return { prefixes: new Set(), unresolved: true, mounted: false };
    active.add(key);
    const edges = incoming.get(key) ?? [];
    const mount: Mount = edges.length
      ? { prefixes: new Set(), unresolved: false, mounted: false }
      : {
          prefixes: new Set(router.prefix === null ? [] : [router.prefix]),
          unresolved: router.prefix === null,
          mounted: router.kind === "app",
        };
    for (const edge of edges) {
      const parent = mountOf(edge.parent, active);
      mount.mounted ||= parent.mounted;
      mount.unresolved ||= parent.unresolved || edge.prefix === null || router.prefix === null;
      if (edge.prefix !== null && router.prefix !== null)
        for (const prefix of parent.prefixes)
          mount.prefixes.add(`${prefix}${edge.prefix}${router.prefix}`);
    }
    active.delete(key);
    mounts.set(key, mount);
    return mount;
  };
  const endpoints: PythonEndpoint[] = [];
  const unresolved = new Set<string>();
  const unmounted = new Set<string>();
  for (const file of files)
    for (const route of file.routes) {
      const key = route.router === null ? undefined : routerKey(file.path, route.router);
      const router = key === undefined ? undefined : routers.get(key);
      let paths = [route.path];
      if (key !== undefined && router) {
        const mount = mountOf(key, new Set());
        if (mount.unresolved) unresolved.add(key);
        if (!mount.mounted) unmounted.add(key);
        paths = mount.prefixes.size
          ? [...mount.prefixes].sort().map((prefix) => joinPath(prefix, route.path))
          : [joinPath(router.prefix ?? "", route.path)];
      }
      for (const path of paths)
        endpoints.push({
          framework: route.framework,
          method: route.method,
          path,
          handler: route.handler,
          line: route.line,
          file: file.path,
        });
    }
  const warnings: PythonRouteResolution["warnings"] = [];
  for (const key of unresolved) {
    const router = routers.get(key) as PythonRouter;
    warnings.push({
      path: routerFiles.get(key) as string,
      code: "fastapi_prefix_unresolved",
      message: `FastAPI router "${router.name}" (line ${router.line}) has a prefix, or is mounted with a prefix, that is not a string literal; its routes keep the path declared in the decorator plus the router's own literal prefix, without the unresolved one.`,
    });
  }
  for (const key of unmounted) {
    const router = routers.get(key) as PythonRouter;
    warnings.push({
      path: routerFiles.get(key) as string,
      code: "fastapi_router_unmounted",
      message: `FastAPI router "${router.name}" (line ${router.line}) is not included by any application found in the analyzed files (including through imports); its routes show only the router's own prefix and may be served under a longer path.`,
    });
  }
  return { endpoints, warnings };
}

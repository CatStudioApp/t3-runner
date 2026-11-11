// Copies the runtime-external packages (and their deps) into a flat node_modules, like upstream's CLI archive.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function findPackageDir(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = NodePath.join(dir, "node_modules", name);
    if (NodeFS.existsSync(NodePath.join(candidate, "package.json")))
      return NodeFS.realpathSync(candidate);
    const parent = NodePath.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function directoryBytes(dir: string): number {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, e) =>
      sum +
      (e.isDirectory()
        ? directoryBytes(NodePath.join(dir, e.name))
        : NodeFS.statSync(NodePath.join(dir, e.name)).size),
    0,
  );
}

/** Stages `roots` resolved from `fromDir` into `stagedRoot`; returns package count and bytes. */
export function stageRuntimeDependencies(
  roots: ReadonlyArray<string>,
  fromDir: string,
  stagedRoot: string,
  log: (message: string) => void,
): { readonly packages: number; readonly bytes: number } {
  NodeFS.rmSync(stagedRoot, { recursive: true, force: true });
  const staged = new Map<string, string>();
  const queue = roots.map((name) => ({ name, from: fromDir, dest: stagedRoot, optional: false }));
  while (queue.length > 0) {
    const { name, from, dest, optional } = queue.shift()!;
    const src = findPackageDir(name, from);
    if (!src) {
      if (!optional) log(`warning: runtime package ${name} not found`);
      continue;
    }
    const existing = staged.get(name);
    if (existing === src) continue;
    const target =
      existing === undefined
        ? NodePath.join(stagedRoot, name)
        : NodePath.join(dest, "node_modules", name);
    if (existing !== undefined && NodeFS.existsSync(target)) continue;
    if (existing === undefined) staged.set(name, src);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.cpSync(src, target, {
      recursive: true,
      dereference: true,
      filter: (file) => !/[\\/]node_modules$/.test(file) || file === src,
    });
    const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(src, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: dep, from: src, dest: target, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      queue.push({ name: dep, from: src, dest: target, optional: true });
  }
  return { packages: staged.size, bytes: directoryBytes(stagedRoot) };
}

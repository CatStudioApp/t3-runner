#!/usr/bin/env bun
/* oxlint-disable t3code/no-global-process-runtime -- Build tooling compares the build host with the executable target. */
/**
 * Builds dist-bun/t3-<os>-<arch>[.exe] with `bun build --compile` (JIT; --aot is opt-in).
 * Native packages stay external and load from dist-bun/node_modules beside the binary.
 * Usage: node scripts/build-bun.ts [--target bun-<os>-<arch>] [--bun <path>] [--aot] [--no-bytecode]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import rootPackageJson from "../../../package.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { loadRepoEnv } from "../../../scripts/lib/public-config.ts";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
const repoDir = NodePath.resolve(serverDir, "../..");

function parseArgs(argv: ReadonlyArray<string>) {
  const out: { target?: string; bun?: string; aot: boolean; bytecode: boolean; explain?: string } =
    {
      aot: false,
      bytecode: true,
    };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--target") out.target = value();
    else if (arg.startsWith("--target=")) out.target = arg.slice(9);
    else if (arg === "--bun") out.bun = value();
    else if (arg.startsWith("--bun=")) out.bun = arg.slice(6);
    else if (arg === "--aot") out.aot = true;
    else if (arg === "--no-bytecode") out.bytecode = false;
    else if (arg === "--explain") out.explain = value();
    else if (arg.startsWith("--explain=")) out.explain = arg.slice(10);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Re-exec under the requested Bun when not already running in it.
const requestedBun = args.bun ?? process.env.BUN_BIN;
const runningBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
if (
  !runningBun ||
  (requestedBun && NodePath.resolve(requestedBun) !== NodePath.resolve(process.execPath))
) {
  const bun = requestedBun ?? "bun";
  const result = NodeChildProcess.spawnSync(bun, [import.meta.filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, BUN_BIN: bun },
  });
  process.exit(result.status ?? 1);
}

const hostOs = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
const target = args.target ?? `bun-${hostOs}-${process.arch}`;
const match = /^bun-(darwin|linux|windows)-(x64|arm64)(?:-[a-z0-9-]+)?$/.exec(target);
if (!match)
  throw new Error(
    `Unsupported --target ${target}; expected bun-<darwin|linux|windows>-<x64|arm64>`,
  );
const [, targetOs, targetArch] = match as unknown as [string, string, string];
const isCross = target !== `bun-${hostOs}-${process.arch}`;
const outDir = NodePath.join(serverDir, "dist-bun");
const outName = `t3-${targetOs}-${targetArch}${targetOs === "windows" ? ".exe" : ""}`;
const outFile = NodePath.join(outDir, outName);
const genDir = NodePath.join(outDir, ".gen");

const repoEnv = loadRepoEnv();
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
  ? "nightly"
  : "latest";
const telemetryChannel = process.env.T3CODE_TELEMETRY_CHANNEL?.trim() || "dev";
if (!["stable", "nightly", "preview", "dev"].includes(telemetryChannel)) {
  throw new Error(`Invalid T3CODE_TELEMETRY_CHANNEL "${telemetryChannel}"`);
}
const define: Record<string, string> = {
  __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
  __T3CODE_TELEMETRY_CHANNEL__: JSON.stringify(telemetryChannel),
  __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
  ),
  __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
    repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
  ),
  // Relay client traces stay off in this build.
  __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(""),
  __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(""),
  __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(""),
};

const clientSrc = [
  NodePath.join(serverDir, "dist/client"),
  NodePath.join(repoDir, "apps/web/dist"),
].find((dir) => NodeFS.existsSync(NodePath.join(dir, "index.html")));
if (!clientSrc) {
  throw new Error("Web client not built. Run `pnpm --filter @t3tools/web build` first.");
}
const clientFiles = (
  NodeFS.readdirSync(clientSrc, { recursive: true, withFileTypes: true }) as NodeFS.Dirent[]
)
  .filter((entry) => entry.isFile())
  .map((entry) => NodePath.relative(clientSrc, NodePath.join(entry.parentPath, entry.name)))
  .filter((rel) => !rel.endsWith(".map"))
  .sort();
const clientHash = NodeCrypto.createHash("sha256");
for (const rel of clientFiles) {
  clientHash
    .update(rel)
    .update("\0")
    .update(NodeFS.readFileSync(NodePath.join(clientSrc, rel)));
}
const clientId = clientHash.digest("hex").slice(0, 16);

NodeFS.rmSync(genDir, { recursive: true, force: true });
NodeFS.mkdirSync(genDir, { recursive: true });
const toPosix = (p: string) => p.split(NodePath.sep).join("/");
NodeFS.writeFileSync(
  NodePath.join(genDir, "client-assets.ts"),
  [
    ...clientFiles.map(
      (rel, i) =>
        `import f${i} from ${JSON.stringify(toPosix(NodePath.join(clientSrc, rel)))} with { type: "file" };`,
    ),
    `export const clientId = ${JSON.stringify(clientId)};`,
    `export const clientFiles: ReadonlyArray<readonly [string, string]> = [`,
    ...clientFiles.map((rel, i) => `  [${JSON.stringify(toPosix(rel))}, f${i}],`),
    `];`,
  ].join("\n"),
);

const entrySource = `// Generated by scripts/build-bun.ts
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
import { clientFiles, clientId } from "./client-assets.ts";

const g = globalThis as Record<string, unknown>;
const exeDir = NodePath.dirname(process.execPath);
g.__T3CODE_BUN_EXE_DIR__ = exeDir;
g.__T3CODE_BUN_EXE_URL__ = NodeUrl.pathToFileURL(process.execPath).href;

function resolveClientDir(): string | undefined {
  const beside = NodePath.join(exeDir, "client");
  if (NodeFS.existsSync(NodePath.join(beside, "index.html"))) return beside;
  const dir = NodePath.join(NodeOs.tmpdir(), "t3code-bun-client-" + clientId);
  const marker = NodePath.join(dir, ".complete");
  if (NodeFS.existsSync(marker)) return dir;
  try {
    const staging = dir + ".tmp-" + process.pid;
    NodeFS.rmSync(staging, { recursive: true, force: true });
    for (const [rel, embedded] of clientFiles) {
      const dest = NodePath.join(staging, rel);
      NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
      NodeFS.writeFileSync(dest, NodeFS.readFileSync(embedded));
    }
    NodeFS.writeFileSync(NodePath.join(staging, ".complete"), "");
    try {
      NodeFS.renameSync(staging, dir);
    } catch {
      // Another process won the race.
      NodeFS.rmSync(staging, { recursive: true, force: true });
    }
    return NodeFS.existsSync(marker) ? dir : undefined;
  } catch {
    return undefined;
  }
}

// Only the server needs the client; skip extraction for the hidden worker subcommands.
const command = process.argv[2];
if (command === undefined || !command.startsWith("_") && !command.startsWith("acp-mcp-")) {
  g.__T3CODE_BUN_CLIENT_DIR__ = resolveClientDir();
}

if (command === "__service-launcher" && process.argv.length === 3) {
  const { runServiceLauncherCli } = await import(${JSON.stringify(toPosix(NodePath.relative(genDir, NodePath.join(serverDir, "src/cli/serviceLauncher.ts"))))});
  await runServiceLauncherCli();
} else {
  const { runCliCommand } = await import(${JSON.stringify(toPosix(NodePath.relative(genDir, NodePath.join(serverDir, "src/binMain.ts"))))});
  await runCliCommand();
}
`;
const entryPath = NodePath.join(genDir, "entry.ts");
NodeFS.writeFileSync(entryPath, entrySource);

const seaShim = `
export const isSea = () => true;
export const getRawAsset = (name) => { throw new Error("No SEA asset " + name + " in the Bun executable"); };
export const getAsset = getRawAsset;
export const getAssetAsBlob = getRawAsset;
export default { isSea, getRawAsset, getAsset, getAssetAsBlob };
`;
const sourceRoots = [NodePath.join(serverDir, "src"), NodePath.join(repoDir, "packages")].map(
  (p) => p + NodePath.sep,
);
const t3BunPlugin: Bun.BunPlugin = {
  name: "t3-bun-exe",
  setup(build) {
    build.onResolve({ filter: /^node:sea$/ }, () => ({ path: "node:sea", namespace: "t3-sea" }));
    build.onLoad({ filter: /.*/, namespace: "t3-sea" }, () => ({
      contents: seaShim,
      loader: "js",
    }));
    // Bun bug: `export * from "ws"` (a CJS package) inside a lazily-initialized module emits a
    // reference to an undefined binding (ReferenceError: ws2 is not defined) in the compiled build.
    build.onLoad({ filter: /platform-node-shared[\\/]dist[\\/]NodeWS\.js$/ }, () => ({
      contents: [
        'import WS from "ws";',
        "export default WS;",
        "export const WebSocket = WS;",
        "export const WebSocketServer = WS.WebSocketServer;",
        "export const createWebSocketStream = WS.createWebSocketStream;",
        "export const Receiver = WS.Receiver;",
        "export const Sender = WS.Sender;",
      ].join("\n"),
      loader: "js",
    }));
    build.onLoad({ filter: /\.tsx?$/ }, async (input) => {
      if (!sourceRoots.some((root) => input.path.startsWith(root))) return undefined;
      if (input.path.includes(`${NodePath.sep}node_modules${NodePath.sep}`)) return undefined;
      let text = await Bun.file(input.path).text();
      const original = text;
      if (input.path === NodePath.join(serverDir, "src/config.ts")) {
        text = text.replace(
          'resolve(join(import.meta.dirname, "client"))',
          '((globalThis as any).__T3CODE_BUN_CLIENT_DIR__ ?? resolve(join((globalThis as any).__T3CODE_BUN_EXE_DIR__, "client")))',
        );
      }
      if (input.path === NodePath.join(serverDir, "src/observability/HeapAttribution.ts")) {
        // Bun's v8.getHeapStatistics() walks the heap (~0.3 ms); this runs twice per span and
        // made startup ~60x slower. process.memoryUsage().heapUsed costs <1 µs in Bun.
        text = text.replace(
          "NodeV8.getHeapStatistics().used_heap_size",
          "process.memoryUsage().heapUsed",
        );
      }
      if (input.path === NodePath.join(serverDir, "src/speech/native.ts")) {
        // transcribe-cpp is resolved with findPackageJSON(name, import.meta.url).
        text = text.replaceAll(
          "import.meta.url",
          "((globalThis as any).__T3CODE_BUN_EXE_URL__ as string)",
        );
      }
      // Resolve native packages, resource-monitor/, etc. beside the executable, as the SEA build does.
      text = text
        .replaceAll(
          "createRequire(import.meta.url)",
          "createRequire((globalThis as any).__T3CODE_BUN_EXE_URL__)",
        )
        .replaceAll(
          "import.meta.dirname",
          "((globalThis as any).__T3CODE_BUN_EXE_DIR__ as string)",
        );
      if (text === original) return undefined;
      return { contents: text, loader: input.path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  },
};

// Runtime-external packages: same list as the Node bundle (scripts/lib/cli-external-packages.ts).
const { isRuntimeExternalCliDependency } =
  await import("../../../scripts/lib/cli-external-packages.ts");
const allDeps = Object.keys({
  ...packageJson.dependencies,
  ...(packageJson as { optionalDependencies?: object }).optionalDependencies,
});
const external = [
  "@cursor/sdk",
  "playwright-core",
  "node-pty",
  "ffi-rs",
  "@yuuang/*",
  "@ff-labs/*",
  "transcribe-cpp",
  "@transcribe-cpp/*",
  "koffi",
  "@koromix/*",
  "@napi-rs/keyring",
  "@clerk/electron-passkeys",
  "node-gyp-build",
  "node-addon-api",
  "bufferutil",
  "utf-8-validate",
  ...allDeps.filter((name) => isRuntimeExternalCliDependency(name)),
];

console.log(
  `[build-bun] ${packageJson.name}@${packageJson.version} target=${target} aot=${args.aot} bytecode=${!args.aot && args.bytecode} bun=${Bun.version}`,
);
console.log(
  `[build-bun] embedding ${clientFiles.length} client files from ${NodePath.relative(repoDir, clientSrc)} (id ${clientId})`,
);
NodeFS.mkdirSync(outDir, { recursive: true });
const started = performance.now();
const result = await Bun.build({
  entrypoints: [entryPath],
  target: "bun",
  format: "esm",
  // Identifier minification breaks the compiled build (ReferenceError at startup); keep names.
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "none",
  bytecode: !args.aot && args.bytecode,
  define,
  external: [...new Set(external)],
  plugins: [t3BunPlugin],
  compile: {
    outfile: outFile,
    target: target as Bun.Build.Target,
    // Standalone executables ignore package.json "main"/"exports" without this, so the native
    // packages in node_modules/ beside the binary would not resolve.
    autoloadPackageJson: true,
    ...(args.aot ? { aot: true, allowCodeFromDisk: true } : {}),
    ...(args.explain ? { aotExplain: args.explain } : {}),
    windows: { hideConsole: false },
  } as never,
});
for (const log of result.logs) console.log(String(log));
if (!result.success) process.exit(1);
const size = NodeFS.statSync(outFile).size;
console.log(
  `[build-bun] ${NodePath.relative(repoDir, outFile)} ${(size / 1024 / 1024).toFixed(1)} MiB in ${((performance.now() - started) / 1000).toFixed(1)}s${isCross ? " (cross-compiled)" : ""}`,
);

// Mirrors upstream's CLI archive: native packages load from disk next to the binary.
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
const stagedRoot = NodePath.join(outDir, "node_modules");
if (isCross) {
  console.log(
    "[build-bun] cross build: skipped staging node_modules (native packages are host-specific)",
  );
} else {
  NodeFS.rmSync(stagedRoot, { recursive: true, force: true });
  const staged = new Map<string, string>(); // name -> source realpath
  const queue: Array<{ name: string; from: string; dest: string; optional: boolean }> = allDeps
    .filter((name) => isRuntimeExternalCliDependency(name))
    .map((name) => ({ name, from: serverDir, dest: stagedRoot, optional: false }));
  while (queue.length > 0) {
    const { name, from, dest, optional } = queue.shift()!;
    const src = findPackageDir(name, from);
    if (!src) {
      if (!optional) console.log(`[build-bun] warning: runtime package ${name} not found`);
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
  const bytes = (dir: string): number =>
    NodeFS.readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, e) =>
        sum +
        (e.isDirectory()
          ? bytes(NodePath.join(dir, e.name))
          : NodeFS.statSync(NodePath.join(dir, e.name)).size),
      0,
    );
  console.log(
    `[build-bun] staged ${staged.size} runtime packages in ${NodePath.relative(repoDir, stagedRoot)} (${(bytes(stagedRoot) / 1024 / 1024).toFixed(1)} MiB)`,
  );
}
void rootPackageJson;

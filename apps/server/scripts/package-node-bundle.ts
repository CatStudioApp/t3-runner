#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- Packaging targets the build host's platform. */
/**
 * Packages the Node flavor of the runner for the host: official Node + apps/server/dist + the
 * runtime-external node_modules, launched by a POSIX sh wrapper `t3`.
 * Usage: node scripts/package-node-bundle.ts [--version <x.y.z>] [--skip-build] [--out <dir>]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import rootPackageJson from "../../../package.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { isRuntimeExternalCliDependency } from "../../../scripts/lib/cli-external-packages.ts";
import { stageRuntimeDependencies } from "./lib/stage-runtime-deps.ts";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const version = flag("--version") ?? packageJson.version;
const outDir = NodePath.resolve(flag("--out") ?? NodePath.join(serverDir, "dist-node"));
const skipBuild = args.includes("--skip-build");

const os = { darwin: "darwin", linux: "linux" }[process.platform as string];
if (!os) throw new Error(`The Node bundle supports macOS and Linux hosts, not ${process.platform}`);
const arch = process.arch;
if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported arch ${arch}`);
const nodeVersion = rootPackageJson.engines.node;
const base = `t3-runner-${version}-${os}-${arch}-node`;
const stage = NodePath.join(outDir, base);
const log = (message: string) => console.log(`[node-bundle] ${message}`);

function run(command: string, commandArgs: ReadonlyArray<string>, cwd = serverDir) {
  const result = NodeChildProcess.spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed`);
}

if (!skipBuild) {
  log("building apps/server/dist (node scripts/cli.ts build)");
  run(process.execPath, ["scripts/cli.ts", "build"]);
}
if (!NodeFS.existsSync(NodePath.join(serverDir, "dist/bin.mjs")))
  throw new Error("dist/bin.mjs missing");
if (!NodeFS.existsSync(NodePath.join(serverDir, "dist/client/index.html"))) {
  throw new Error("dist/client missing: build apps/web first (pnpm --filter @t3tools/web build)");
}

NodeFS.rmSync(stage, { recursive: true, force: true });
NodeFS.mkdirSync(stage, { recursive: true });

// Node runtime, verified against the release's SHASUMS256.txt.
const nodeName = `node-v${nodeVersion}-${os}-${arch}`;
const nodeTarball = `${nodeName}.tar.gz`;
const cacheDir = NodePath.join(outDir, ".cache");
NodeFS.mkdirSync(cacheDir, { recursive: true });
const tarballPath = NodePath.join(cacheDir, nodeTarball);
const distUrl = `https://nodejs.org/dist/v${nodeVersion}`;
const shasums = await (await fetch(`${distUrl}/SHASUMS256.txt`)).text();
const expected = shasums
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === nodeTarball)?.[0];
if (!expected) throw new Error(`${nodeTarball} not listed in SHASUMS256.txt`);
const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
if (!NodeFS.existsSync(tarballPath) || sha256(tarballPath) !== expected) {
  log(`downloading ${distUrl}/${nodeTarball}`);
  const response = await fetch(`${distUrl}/${nodeTarball}`);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  NodeFS.writeFileSync(tarballPath, Buffer.from(await response.arrayBuffer()));
}
const actual = sha256(tarballPath);
if (actual !== expected) throw new Error(`checksum mismatch for ${nodeTarball}: ${actual}`);
log(`node ${nodeVersion} checksum OK`);
run("tar", ["-xzf", tarballPath, "-C", stage]);
const nodeDir = NodePath.join(stage, "node");
NodeFS.renameSync(NodePath.join(stage, nodeName), nodeDir);
// Only bin/node is needed to run the server.
for (const unused of [
  "include",
  "share",
  "lib/node_modules",
  "bin/npm",
  "bin/npx",
  "bin/corepack",
]) {
  NodeFS.rmSync(NodePath.join(nodeDir, unused), { recursive: true, force: true });
}

// Server: dist/ is bundled except for the runtime externals staged beside it.
const libDir = NodePath.join(stage, "lib");
NodeFS.mkdirSync(libDir);
NodeFS.cpSync(NodePath.join(serverDir, "dist"), NodePath.join(libDir, "dist"), {
  recursive: true,
  filter: (file) => !file.endsWith(".map"),
});
NodeFS.writeFileSync(
  NodePath.join(libDir, "package.json"),
  `${JSON.stringify({ name: "t3", version, type: "module", private: true }, null, 2)}\n`,
);
const deps = Object.keys({
  ...packageJson.dependencies,
  ...(packageJson as { optionalDependencies?: Record<string, string> }).optionalDependencies,
}).filter((name) => isRuntimeExternalCliDependency(name));
const staged = stageRuntimeDependencies(
  deps,
  serverDir,
  NodePath.join(libDir, "node_modules"),
  log,
);
log(`staged ${staged.packages} runtime packages (${(staged.bytes / 1024 / 1024).toFixed(1)} MiB)`);

// Launcher: resolve symlinks (the installer links ~/.local/bin/t3 -> current/t3).
const wrapper = `#!/bin/sh
# T3 Runner (Node flavor) launcher.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
DIR=$(cd "$(dirname "$self")" && pwd -P)
exec "$DIR/node/bin/node" "$DIR/lib/dist/bin.mjs" "$@"
`;
NodeFS.writeFileSync(NodePath.join(stage, "t3"), wrapper, { mode: 0o755 });

const archive = NodePath.join(outDir, `${base}.tar.gz`);
NodeFS.rmSync(archive, { force: true });
run("tar", ["-czf", archive, base], outDir);
log(`${archive} (${(NodeFS.statSync(archive).size / 1024 / 1024).toFixed(1)} MiB)`);

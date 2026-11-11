#!/bin/sh
# Installer for the T3 Runner (CatStudioApp/t3-runner): the `t3` server/CLI built with Bun.
# macOS + Linux, POSIX sh, no sudo. Re-run it any time to update; --uninstall removes it.
#
#   curl -fsSL https://raw.githubusercontent.com/CatStudioApp/t3-runner/bun-runner/scripts/install-runner.sh | sh
#
# Env:
#   T3_RUNNER_VERSION   pin a version, e.g. 0.1.9 (default: latest cat-v* release)
#   T3_RUNNER_HOME      install root (default: $HOME/.t3-runner)
#   T3_RUNNER_BIN_DIR   where the `t3` symlink goes (default: $HOME/.local/bin)
#   T3_RUNNER_REPO      GitHub repo (default: CatStudioApp/t3-runner)
#   T3_RUNNER_BASE_URL  testing: directory URL holding the archive + SHA256SUMS (needs T3_RUNNER_VERSION)
#   T3_RUNNER_FLAVOR    bun | node (default: node on Intel Macs, bun elsewhere). The node flavor
#                       bundles Node.js + the server and has working terminals (node-pty).
set -eu

REPO=${T3_RUNNER_REPO:-CatStudioApp/t3-runner}
RUNNER_HOME=${T3_RUNNER_HOME:-$HOME/.t3-runner}
BIN_DIR=${T3_RUNNER_BIN_DIR:-$HOME/.local/bin}
BASE_URL=${T3_RUNNER_BASE_URL:-}
VERSION=${T3_RUNNER_VERSION:-}
VERSION=${VERSION#cat-v}
VERSION=${VERSION#v}
FLAVOR=${T3_RUNNER_FLAVOR:-}
case "$FLAVOR" in
  ""|bun|node) ;;
  *) echo "error: T3_RUNNER_FLAVOR must be bun or node, got: $FLAVOR" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

TMP=
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT INT TERM

# Point a symlink at a target atomically (rename over it), falling back to ln -sfn.
link_atomic() {
  _target=$1 _link=$2 _tmp="$2.new.$$"
  rm -f "$_tmp"
  ln -s "$_target" "$_tmp"
  if mv -fT "$_tmp" "$_link" 2>/dev/null || mv -fh "$_tmp" "$_link" 2>/dev/null; then
    return 0
  fi
  rm -f "$_tmp"
  ln -sfn "$_target" "$_link"
}

# ---------------------------------------------------------------- uninstall
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then
  link="$BIN_DIR/t3"
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in
      "$RUNNER_HOME"/*) rm -f "$link"; say "Removed $link" ;;
      *) warn "$link does not point into $RUNNER_HOME; left alone" ;;
    esac
  fi
  if [ -d "$RUNNER_HOME" ]; then
    rm -rf "$RUNNER_HOME"
    say "Removed $RUNNER_HOME"
  else
    say "Nothing at $RUNNER_HOME"
  fi
  say "Your T3 data (~/.t3) was kept. If you installed the background service, run"
  say "'t3 service uninstall' BEFORE uninstalling (or remove the service by hand)."
  exit 0
fi
case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
  *) die "unknown argument: $1 (only --uninstall is supported)" ;;
esac

# ---------------------------------------------------------------- platform
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) die "unsupported OS: $os (on Windows use install-runner.ps1)" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "unsupported CPU architecture: $arch" ;;
esac
if [ "$platform" = darwin ] && [ "$arch" = x64 ]; then
  # A shell running under Rosetta reports x86_64 on an Apple Silicon Mac; prefer native.
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ] ||
    [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
fi

# ---------------------------------------------------------------- tooling
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
  fetch_stdout() { curl -fsSL --retry 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_stdout() { wget -q -O - "$1"; }
else
  die "need curl or wget"
fi
command -v tar >/dev/null 2>&1 || die "need tar"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "need sha256sum or shasum to verify the download"
fi

# ---------------------------------------------------------------- resolve version
if [ -z "$VERSION" ]; then
  [ -z "$BASE_URL" ] || die "T3_RUNNER_BASE_URL requires T3_RUNNER_VERSION"
  say "Looking up the latest release of $REPO ..."
  releases=$(fetch_stdout "https://api.github.com/repos/$REPO/releases?per_page=30") ||
    die "could not query GitHub releases (rate limited? set T3_RUNNER_VERSION=<x.y.z> to skip the lookup)"
  VERSION=$(printf '%s' "$releases" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"cat-v[^"]*"' |
    head -n 1 | sed 's/.*"cat-v\([^"]*\)"/\1/')
  [ -n "$VERSION" ] || die "no cat-v* release found in $REPO"
fi
case "$VERSION" in
  *[!A-Za-z0-9._-]*|"") die "invalid version: $VERSION" ;;
esac

[ -n "$BASE_URL" ] || BASE_URL="https://github.com/$REPO/releases/download/cat-v$VERSION"
BASE_URL=${BASE_URL%/}

flavor_explicit=1
if [ -z "$FLAVOR" ]; then
  flavor_explicit=0
  if [ "$platform" = darwin ] && [ "$arch" = x64 ]; then FLAVOR=node; else FLAVOR=bun; fi
fi

# Sets archive/dest for $FLAVOR. The node archive's top dir and version dir carry a -node suffix.
select_flavor() {
  base="t3-runner-$VERSION-$platform-$arch"
  dest="$RUNNER_HOME/versions/$VERSION"
  if [ "$FLAVOR" = node ]; then
    base="$base-node"
    dest="$dest-node"
  fi
  archive="$base.tar.gz"
}
select_flavor

# ---------------------------------------------------------------- download + install
if [ -x "$dest/t3" ]; then
  say "t3 runner $VERSION ($FLAVOR) is already extracted at $dest"
else
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/t3-runner.XXXXXX")
  fetch "$BASE_URL/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $BASE_URL/SHA256SUMS"
  listed() { awk -v f="$1" '{n=$2; sub(/^\*/,"",n)} n==f {print $1; exit}' "$TMP/SHA256SUMS"; }
  expected=$(listed "$archive")
  if [ -z "$expected" ] && [ "$FLAVOR" = node ] && [ "$flavor_explicit" = 0 ]; then
    warn "release $VERSION has no Node flavor for $platform-$arch; installing the Bun build"
    FLAVOR=bun
    select_flavor
    expected=$(listed "$archive")
  fi
  [ -n "$expected" ] || die "$archive is not listed in SHA256SUMS"
  if [ -x "$dest/t3" ]; then
    say "t3 runner $VERSION ($FLAVOR) is already extracted at $dest"
  else
    say "Downloading $archive ..."
    fetch "$BASE_URL/$archive" "$TMP/$archive" || die "download failed: $BASE_URL/$archive"
    actual=$(sha256 "$TMP/$archive")
    [ "$expected" = "$actual" ] || die "checksum mismatch for $archive (expected $expected, got $actual)"
    say "Checksum OK ($actual)"

    mkdir -p "$RUNNER_HOME/versions"
    stage="$RUNNER_HOME/versions/.stage.$$"
    rm -rf "$stage"
    mkdir -p "$stage"
    tar -xzf "$TMP/$archive" -C "$stage" --strip-components=1
    [ -f "$stage/t3" ] || { rm -rf "$stage"; die "archive layout unexpected: no t3 launcher"; }
    chmod +x "$stage/t3"
    if [ "$platform" = darwin ]; then
      xattr -dr com.apple.quarantine "$stage" 2>/dev/null || true
    fi
    rm -rf "$dest"
    mv "$stage" "$dest"
  fi
fi

link_atomic "$dest" "$RUNNER_HOME/current"

mkdir -p "$BIN_DIR"
if [ -e "$BIN_DIR/t3" ] || [ -L "$BIN_DIR/t3" ]; then
  if [ -L "$BIN_DIR/t3" ]; then
    case "$(readlink "$BIN_DIR/t3")" in
      "$RUNNER_HOME"/*) ;;
      *) warn "replacing existing symlink $BIN_DIR/t3 -> $(readlink "$BIN_DIR/t3")" ;;
    esac
  else
    die "$BIN_DIR/t3 exists and is not a symlink (a different t3 install?). Move it, or set T3_RUNNER_BIN_DIR."
  fi
fi
link_atomic "$RUNNER_HOME/current/t3" "$BIN_DIR/t3"

# ---------------------------------------------------------------- report
say ""
if ver=$("$BIN_DIR/t3" --version 2>&1); then
  say "Installed: $ver, $FLAVOR flavor  ($BIN_DIR/t3 -> $RUNNER_HOME/current/t3)"
else
  warn "installed, but 't3 --version' failed: $ver"
fi

# Is $BIN_DIR on PATH, and is some other t3 shadowing ours?
on_path=0
first_t3=
oldifs=$IFS; IFS=:
for p in $PATH; do
  [ "$p" = "$BIN_DIR" ] && on_path=1
  if [ -z "$first_t3" ] && [ -x "$p/t3" ] && [ ! -d "$p/t3" ]; then first_t3="$p/t3"; fi
done
IFS=$oldifs
if [ "$on_path" = 0 ]; then
  warn "$BIN_DIR is not on your PATH. Add it, e.g.:"
  say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile   # or ~/.zshrc / ~/.bashrc"
elif [ -n "$first_t3" ] && [ "$first_t3" != "$BIN_DIR/t3" ]; then
  warn "another t3 comes first on your PATH: $first_t3 (it shadows this runner). Use $BIN_DIR/t3 or reorder PATH."
fi

cat <<EOT

Next steps
  Start the server (prints a Pairing URL, App link, Token and QR code):
      t3 serve
  Keep it running in the background (macOS/Linux):
      t3 service install
  Reach it from other devices:
      t3 up            # choose T3 Connect and/or local network
      t3 pair          # mint a fresh pairing URL/QR for a running server
  Then paste the Pairing URL (or scan the QR) in the desktop/web/mobile app's "Add environment".
  Treat pairing URLs and tokens like passwords.

Update: re-run this installer (do NOT use 't3 update': it installs upstream Node builds).
Remove: sh install-runner.sh --uninstall
EOT
if [ "$FLAVOR" = bun ]; then
  say "Note: the built-in terminal (node-pty) does not work in the Bun build yet (T3_RUNNER_FLAVOR=node has it on Intel Macs)."
fi

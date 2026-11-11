---
name: t3-runner-install
description: Install, update, uninstall, start, and pair the CatStudioApp T3 Runner (the Bun build of the T3 Code `t3` server, github.com/CatStudioApp/t3-runner) on a Mac, Linux or Windows machine, locally or on a remote host over ssh. Use whenever the user says install/update/remove "t3 runner", "t3-runner", "CatStudioApp t3", "the runner", wants a T3 Code server on a box/VPS/homelab, wants to start it or keep it running in the background, asks for the pairing code / pairing URL / token / QR, or wants to pair or re-pair the T3 desktop, web or mobile app with a host.
---

# T3 Runner: install, start, pair

The runner is the T3 Code server/CLI `t3` built with Bun by the fork CatStudioApp/t3-runner. Installers fetch a GitHub Release archive (`t3` + a `node_modules/` that must stay beside it), verify `SHA256SUMS`, and need no sudo.

## Install

macOS / Linux (installs to `~/.t3-runner`, links `~/.local/bin/t3`):

```sh
curl -fsSL https://raw.githubusercontent.com/CatStudioApp/t3-runner/bun-runner/scripts/install-runner.sh | sh
```

Remote host: `ssh HOST 'curl -fsSL https://raw.githubusercontent.com/CatStudioApp/t3-runner/bun-runner/scripts/install-runner.sh | sh'`. The remote only needs curl (or wget) and tar.

Windows PowerShell (installs to `%LOCALAPPDATA%\t3-runner`, adds it to the user PATH):

```powershell
irm https://raw.githubusercontent.com/CatStudioApp/t3-runner/bun-runner/scripts/install-runner.ps1 | iex
```

Options (env vars): `T3_RUNNER_VERSION=0.1.9` pins a version; `T3_RUNNER_HOME`, `T3_RUNNER_BIN_DIR` relocate it.

Verify with the full path, because a non-interactive ssh shell often lacks `~/.local/bin` on PATH: `~/.local/bin/t3 --version`. If the installer warns that the bin dir is not on PATH or that another `t3` shadows it, relay that warning to the user instead of editing their shell files unasked.

## Update and uninstall

- Update = re-run the installer. It is idempotent and switches a `current` symlink atomically. Never use `t3 update`: it downloads upstream Node builds and would replace this one.
- Uninstall: `curl -fsSL <installer url> | sh -s -- --uninstall` (Windows: `$env:T3_RUNNER_UNINSTALL='1'` then the `irm | iex` line). If a background service was installed, run `t3 service uninstall` first. User data in `~/.t3` is kept.

## Start

- Foreground: `t3 serve`. It prints `T3 Code server is ready.` followed by `Connection string`, `Token`, `Pairing URL`, `App link` and a QR code.
- Background (macOS/Linux; systemd user service on Linux, launch agent on macOS): `t3 service install`, check with `t3 service status`, restart with `t3 service restart`. Windows has no service: keep `t3 serve` running in a terminal.
- Reach it from other devices: `t3 up` asks for T3 Connect, local network, or both (flags `--connect`, `--lan`, `--yes` skip prompts; without a terminal, T3 Connect sign-in prints a URL and code to approve on any device). `t3 status` shows the current setup (`--json` for scripts). By default only this machine can connect; for direct LAN/tailnet pairing use `t3 serve --lan` (or `t3 up --lan`), which makes the pairing code the only gate.
- The host also needs at least one provider CLI installed and logged in (for example `claude auth login`, `codex login`); the server runs agents with those.

Over ssh, run long-lived things so they outlive the session: prefer `t3 service install` on Linux/macOS, not a backgrounded `t3 serve`.

## Get and present the pairing code

Pairing URLs are one-time and expire, so mint one when the user is ready to use it.

- Server already running (including as a service): `t3 pair` (add `--ttl`, `--label`, or `--scope` to narrow permissions; `--tailscale` for a Tailscale HTTPS link). Output: QR code, `Pairing URL:`, `App link:` (`t3code://pair...`), `Token:`, `Expires:`, plus notes. Over ssh run `ssh HOST '~/.local/bin/t3 pair'`.
- Foreground `t3 serve` prints the same on startup.
- Without the QR/ANSI noise: `t3 auth pairing create`. List or revoke with `t3 auth pairing list|revoke`, and manage paired devices with `t3 auth session list|revoke <id>`.

Present it to the user verbatim, in a code block, with: the Pairing URL, the Token, the expiry, and which route it works over. If a note says the URL is loopback-only or LAN-only, say so, because a phone cannot use `127.0.0.1`. Remind them it is a secret that grants access to the machine's agents: do not paste it into shared channels, issues or logs, and do not store it.

Pairing in the client: desktop/web/mobile app, Settings, Environments, Add environment, paste the Pairing URL or scan the QR (on a computer with the desktop app, the `t3code://pair` App link also works). Re-pairing a device or changing its permissions = run `t3 pair` again and add the environment again with the fresh link.

## Privacy

Product analytics are off by default in this build. For a hard lock-down on a Linux host (managed policy `/etc/t3code/policy.json` with `limits.telemetry=false`, env vars, and an `/etc/hosts` block for `ingest.t3.codes`), use the `t3code-runner-safe-modify` skill; it needs root, so ask first.

## Known limitations

- The built-in terminal (node-pty) does not work under Bun yet; agent work and the rest of the app do.
- `t3 update` and the desktop app's "SSH" environment bootstrap install upstream Node builds into `~/.t3/runtime` and can replace or bypass this build. For a runner host, pair over its Pairing URL or T3 Connect instead of letting the desktop bootstrap over SSH.
- Published targets: darwin arm64/x64, linux x64/arm64, windows x64. On Apple Silicon the installer picks arm64 even from a Rosetta shell.
- Releases are tags `cat-v<version>` on GitHub; if the API lookup is rate limited, pass `T3_RUNNER_VERSION`.

# Installer for the T3 Runner (CatStudioApp/t3-runner): the `t3` server/CLI built with Bun.
# Windows PowerShell 5.1+ / PowerShell 7. No admin rights. Re-run any time to update.
#
#   irm https://raw.githubusercontent.com/CatStudioApp/t3-runner/bun-runner/scripts/install-runner.ps1 | iex
#
# Env (set before running):
#   T3_RUNNER_VERSION   pin a version, e.g. 0.1.9 (default: latest cat-v* release)
#   T3_RUNNER_HOME      install root (default: $env:LOCALAPPDATA\t3-runner)
#   T3_RUNNER_REPO      GitHub repo (default: CatStudioApp/t3-runner)
#   T3_RUNNER_BASE_URL  testing: directory URL (or local path) with the zip + SHA256SUMS (needs T3_RUNNER_VERSION)
#   T3_RUNNER_UNINSTALL=1  uninstall instead of install (the way to pass a flag through `irm | iex`)
# Direct run also accepts:  .\install-runner.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

function Get-Setting($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($v)) { return $default } else { return $v }
}

$Repo = Get-Setting 'T3_RUNNER_REPO' 'CatStudioApp/t3-runner'
$Root = Get-Setting 'T3_RUNNER_HOME' (Join-Path $env:LOCALAPPDATA 't3-runner')
$BaseUrl = Get-Setting 'T3_RUNNER_BASE_URL' ''
$Version = (Get-Setting 'T3_RUNNER_VERSION' '') -replace '^cat-v', '' -replace '^v', ''
$Current = Join-Path $Root 'current'   # junction to versions\<ver>; this folder is what goes on PATH
if ((Get-Setting 'T3_RUNNER_UNINSTALL' '') -eq '1') { $Uninstall = $true }

function Remove-Link($path) {
    # Deletes a junction/symlink itself, never its target's contents.
    if (Test-Path -LiteralPath $path) { [System.IO.Directory]::Delete($path, $false) }
}

function Get-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }
function Split-Path-Entries($p) { if ($p) { $p -split ';' | Where-Object { $_ } } else { @() } }

if ($Uninstall) {
    $entries = Split-Path-Entries (Get-UserPath) | Where-Object { $_.TrimEnd('\') -ne $Current.TrimEnd('\') }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    Remove-Link $Current
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
    Write-Host "Removed $Root and its PATH entry."
    Write-Host "Your T3 data (~\.t3) was kept. Open a new terminal for PATH to refresh."
    return
}

$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') {
    throw "Unsupported architecture '$arch': only windows-x64 is published (Windows on ARM runs it under emulation; try from an x64 PowerShell)."
}

if (-not $Version) {
    if ($BaseUrl) { throw 'T3_RUNNER_BASE_URL requires T3_RUNNER_VERSION' }
    Write-Host "Looking up the latest release of $Repo ..."
    try {
        $releases = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers @{ 'User-Agent' = 't3-runner-installer' }
    } catch {
        throw "Could not query GitHub releases ($($_.Exception.Message)). Set T3_RUNNER_VERSION=<x.y.z> to skip the lookup."
    }
    $latest = $releases | Where-Object { $_.tag_name -like 'cat-v*' -and -not $_.draft } | Select-Object -First 1
    if (-not $latest) { throw "No cat-v* release found in $Repo" }
    $Version = $latest.tag_name -replace '^cat-v', ''
}
if ($Version -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid version: $Version" }

$base = "t3-runner-$Version-windows-x64"
$archive = "$base.zip"
if (-not $BaseUrl) { $BaseUrl = "https://github.com/$Repo/releases/download/cat-v$Version" }
$BaseUrl = $BaseUrl.TrimEnd('/', '\')
$dest = Join-Path $Root "versions\$Version"

function Get-Asset($name, $out) {
    if ($BaseUrl -match '^https?://') {
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$name" -OutFile $out
    } else {
        Copy-Item -LiteralPath (Join-Path $BaseUrl $name) -Destination $out
    }
}

if (Test-Path -LiteralPath (Join-Path $dest 't3.exe')) {
    Write-Host "t3 runner $Version is already extracted at $dest"
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("t3-runner." + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Write-Host "Downloading $archive ..."
        Get-Asset $archive (Join-Path $tmp $archive)
        Get-Asset 'SHA256SUMS' (Join-Path $tmp 'SHA256SUMS')

        $expected = $null
        foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')) {
            if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $archive) { $expected = $Matches[1]; break }
        }
        if (-not $expected) { throw "$archive is not listed in SHA256SUMS" }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tmp $archive)).Hash
        if ($actual -ne $expected.ToUpperInvariant()) { throw "Checksum mismatch for $archive (expected $expected, got $actual)" }
        Write-Host "Checksum OK ($($actual.ToLowerInvariant()))"

        $extract = Join-Path $tmp 'x'
        Expand-Archive -LiteralPath (Join-Path $tmp $archive) -DestinationPath $extract -Force
        $src = Join-Path $extract $base
        if (-not (Test-Path -LiteralPath (Join-Path $src 't3.exe'))) { throw 'Archive layout unexpected: no t3.exe' }

        New-Item -ItemType Directory -Force -Path (Join-Path $Root 'versions') | Out-Null
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
        Move-Item -LiteralPath $src -Destination $dest
        # Files from the web carry Mark-of-the-Web only when saved by a browser; clear defensively.
        Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Switch `current` (a junction needs no admin rights). Running t3.exe from an older
# version keeps working because it lives in its own versions\<ver> folder.
Remove-Link $Current
New-Item -ItemType Junction -Path $Current -Target $dest | Out-Null

$entries = @(Split-Path-Entries (Get-UserPath))
if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $Current.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $Current) -join ';'), 'User')
    Write-Host "Added $Current to your user PATH (open a new terminal to pick it up)."
}
if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $Current.TrimEnd('\') })) {
    $env:Path = "$Current;$env:Path"   # usable in this window right away
}

$other = Get-Command t3 -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -and -not $_.Source.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
if ($other) { Write-Warning "Another t3 exists at $($other.Source); the runner is first on PATH only in new terminals if it comes earlier. Use $Current\t3.exe to be sure." }

Write-Host ''
try { Write-Host ("Installed: " + (& (Join-Path $Current 't3.exe') --version 2>&1)) } catch { Write-Warning "Installed, but 't3 --version' failed: $_" }

@"

Next steps
  Start the server (prints a Pairing URL, App link, Token and QR code):
      t3 serve
  (Windows has no background service: keep that terminal open, or run it from Task Scheduler.)
  Reach it from other devices:
      t3 up            # T3 Connect and/or local network
      t3 pair          # mint a fresh pairing URL/QR for a running server
  Then paste the Pairing URL (or scan the QR) in the desktop/web/mobile app's "Add environment".
  Treat pairing URLs and tokens like passwords.

Update: re-run this installer (do NOT use 't3 update': it installs upstream Node builds).
Remove: `$env:T3_RUNNER_UNINSTALL='1'; irm https://raw.githubusercontent.com/$Repo/bun-runner/scripts/install-runner.ps1 | iex
Note: the built-in terminal (node-pty) does not work in this Bun build yet.
"@ | Write-Host

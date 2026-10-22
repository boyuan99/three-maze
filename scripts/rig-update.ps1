<#
.SYNOPSIS
Updates three-maze on the rig computer and prints the versions it will run (plan item REL-02).

.DESCRIPTION
Run it at the start of every rig visit, from the repository folder, with three-maze closed:

    powershell -ExecutionPolicy Bypass -File scripts\rig-update.ps1
    powershell -ExecutionPolicy Bypass -File scripts\rig-update.ps1 -Ref phase1-gate-1

Steps, each timed:
  1. git: refuses if tracked files have local changes; fetches; checks out -Ref if given (a tag or a
     branch); pulls the current branch (fast-forward only).
  2. npm ci: reinstalls node_modules exactly as package-lock.json says; its postinstall
     (setup/setup-python.js) creates or updates .venv with the Python packages.
  3. npx --no install-electron: since Electron 42, npm ci no longer downloads the Electron binary.
  4. pip install -r requirements.txt into .venv: the backend's exact pins (a no-op when step 2
     installed them).
  5. The versions: git commit, Node, npm, Electron (package and binary), three.js, Rapier, Python
     and every package pinned in requirements.txt, installed against pinned.
Steps 1-4 need network access (GitHub, the npm registry, the Electron download, PyPI). The printout
is also saved in out\rig-update\rig-update-<computer>-<date>-<time>.txt.

Exit code: 0 done and every pin matches; 1 a step failed or a version does not match its pin.

.PARAMETER Ref
A tag or branch to check out before pulling (default: stay on the current branch).

.PARAMETER NoPull
Skip step 1 (git), for example on a fresh clone.
#>
param(
  [string]$Ref = '',
  [switch]$NoPull
)

$ErrorActionPreference = 'Continue' # native programs report failure through their exit codes
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
# Electron would run as plain Node with this set (it is set in some development shells)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$lines = New-Object System.Collections.Generic.List[string]
$timings = New-Object System.Collections.Generic.List[object]
$total = [Diagnostics.Stopwatch]::StartNew()
$problems = New-Object System.Collections.Generic.List[string]

function Say([string]$text) {
  Write-Host $text
  $lines.Add($text)
}

function Invoke-Step([string]$name, [scriptblock]$block) {
  Say "==> $name"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $global:LASTEXITCODE = 0
  $script:why = 'Steps 1-4 need network access (GitHub, npm, the Electron download, PyPI).'
  & $block
  $code = $LASTEXITCODE
  $sw.Stop()
  $timings.Add([pscustomobject]@{ step = $name; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
  if ($code -ne 0) {
    throw "$name failed (exit code $code). $script:why"
  }
}

function Get-Output([string]$exe, [string[]]$arguments) {
  try {
    $out = & $exe @arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return "(exit code $LASTEXITCODE)" }
    return (($out | Out-String).Trim())
  } catch {
    return '(not found)'
  }
}

function Get-PackageVersion([string]$name) {
  $file = Join-Path $repo (Join-Path 'node_modules' (Join-Path $name 'package.json'))
  if (-not (Test-Path $file)) { return '(not installed)' }
  return (Get-Content $file -Raw | ConvertFrom-Json).version
}

# electron.exe is a GUI program: PowerShell does not capture its output with &, so redirect it
function Get-ElectronBinaryVersion([string]$exe) {
  if (-not (Test-Path $exe)) { return '' }
  $tmp = [IO.Path]::GetTempFileName()
  try {
    Start-Process -FilePath $exe -ArgumentList '--version' -NoNewWindow -Wait -RedirectStandardOutput $tmp | Out-Null
    return ((Get-Content $tmp -Raw) + '').Trim()
  } catch {
    return ''
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

function Normalize([string]$name) {
  return ($name.ToLower() -replace '[-_.]+', '-')
}

$failed = $null
try {
  if (-not $NoPull) {
    Invoke-Step '1. git' {
      $dirty = git status --porcelain --untracked-files=no
      if ($LASTEXITCODE -ne 0) { return }
      if ($dirty) {
        Say 'Tracked files have local changes; commit or undo them first (git status), then run this again:'
        $dirty | ForEach-Object { Say "  $_" }
        $script:why = 'Nothing was changed.'
        $global:LASTEXITCODE = 1
        return
      }
      git fetch --tags origin
      if ($LASTEXITCODE -ne 0) { return }
      if ($Ref) {
        git checkout $Ref
        if ($LASTEXITCODE -ne 0) { return }
      }
      $branch = git symbolic-ref --quiet --short HEAD
      if ($branch) {
        git pull --ff-only
      } else {
        $at = git describe --tags --always
        Say "On $at, a tag or a commit, not a branch: nothing to pull (use -Ref to move to another one)"
        $global:LASTEXITCODE = 0
      }
    }
  }
  Invoke-Step '2. npm ci' { npm.cmd ci }
  Invoke-Step '3. Electron binary' { npx.cmd --no install-electron }
  Invoke-Step '4. Python packages' { & (Join-Path $repo '.venv\Scripts\python.exe') -m pip install --disable-pip-version-check -r requirements.txt }
} catch {
  $failed = $_.Exception.Message
}

# 5. Versions (also after a failed step: they show what the rig has now)
Say ''
Say '==> 5. versions'
$python = Join-Path $repo '.venv\Scripts\python.exe'
$electronExe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
Say ("  three-maze     " + (Get-Output 'git' @('describe', '--tags', '--always', '--dirty')) + ' (' + (Get-Output 'git' @('rev-parse', 'HEAD')) + ')')
Say ("  Node           " + (Get-Output 'node' @('--version')))
Say ("  npm            " + (Get-Output 'npm.cmd' @('--version')))
$electronBinary = Get-ElectronBinaryVersion $electronExe
if (-not $electronBinary) { $problems.Add('the Electron binary is missing or does not start (npx --no install-electron)') }
elseif ($electronBinary -ne ('v' + (Get-PackageVersion 'electron'))) { $problems.Add("the Electron binary is $electronBinary, the package $(Get-PackageVersion 'electron')") }
Say ("  Electron       " + (Get-PackageVersion 'electron') + ' (package), ' + $(if ($electronBinary) { "$electronBinary (binary)" } else { 'binary missing' }))
Say ("  three          " + (Get-PackageVersion 'three'))
Say ("  Rapier         " + (Get-PackageVersion '@dimforge/rapier3d-compat'))
Say ("  Python         " + $(if (Test-Path $python) { Get-Output $python @('--version') } else { '.venv missing' }))
$expected = @{ 'electron' = 'electron'; 'three' = 'three'; 'rapier' = '@dimforge/rapier3d-compat' }
$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
foreach ($k in $expected.Keys) {
  $name = $expected[$k]
  $pin = $pkg.dependencies.$name
  if (-not $pin) { $pin = $pkg.devDependencies.$name }
  if ($pin -and ((Get-PackageVersion $name) -ne $pin)) { $problems.Add("$name is $(Get-PackageVersion $name), package.json pins $pin") }
}
if (Test-Path $python) {
  $installed = @{}
  foreach ($l in (& $python -m pip freeze --disable-pip-version-check 2>$null)) {
    if ($l -match '^([A-Za-z0-9_.-]+)==(\S+)$') { $installed[(Normalize $Matches[1])] = $Matches[2] }
  }
  Say '  Python packages (installed / pinned in requirements.txt):'
  foreach ($l in (Get-Content (Join-Path $repo 'requirements.txt'))) {
    if ($l -match '^\s*([A-Za-z0-9_.-]+)==([^\s;#]+)') {
      $name = $Matches[1]
      $pin = $Matches[2]
      $have = $installed[(Normalize $name)]
      if (-not $have) {
        if ($l -match 'sys_platform') { $have = '(not for this platform)' } else { $have = '(missing)'; $problems.Add("Python package $name is missing") }
      } elseif ($have -ne $pin) {
        $problems.Add("Python package $name is $have, requirements.txt pins $pin")
      }
      Say ("    {0,-20} {1,-14} {2}" -f $name, $have, $pin)
    }
  }
}
$total.Stop()
Say ''
foreach ($t in $timings) { Say ("  {0,-22} {1,6} s" -f $t.step, $t.seconds) }
Say ("  total                  {0,6} s" -f [math]::Round($total.Elapsed.TotalSeconds, 1))
foreach ($p in $problems) { Say "  MISMATCH: $p" }
if ($failed) { Say "FAILED: $failed" }
elseif ($problems.Count) { Say 'DONE, but some versions do not match their pins (see MISMATCH)' }
else { Say 'DONE: every pinned version matches' }

$outDir = Join-Path $repo 'out\rig-update'
New-Item -ItemType Directory -Force $outDir | Out-Null
$log = Join-Path $outDir ("rig-update-{0}-{1}.txt" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyyMMdd-HHmmss'))
$lines | Set-Content -Path $log -Encoding UTF8
Write-Host "saved in $log"
if ($failed -or $problems.Count) { exit 1 }
exit 0

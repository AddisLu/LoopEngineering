<#
  setup-windows.ps1 — one-shot setup for the COMPANY Windows 11 host to run Loop Engineering
  as a FULL AUTONOMOUS engine using the GitHub Copilot CLI backend (Copilot Business).

  What it does (idempotent; safe to re-run):
    1. checks prerequisites (Node >= 22, git, python);
    2. installs deps + builds (npm ci; npm run build);
    3. writes %USERPROFILE%\.config\loop-engineering\env (random LOOP_API_TOKEN) if missing —
       this is what src/config.ts loadEnvFile() reads (no systemd here);
    4. installs the GitHub Copilot CLI (npm i -g @github/copilot) and reminds you to `copilot login`;
    5. installs python-pptx==1.0.2 for the weekly-report tooling (Python 3.8.10 target);
    6. applies the Copilot-host config presets via `loop config set`;
    7. installs an NSSM Windows service (loop-engineering) if nssm is available.

  Usage (from an elevated PowerShell, in a full clone of the repo):
    powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1

  Override via params or env:
    -ServiceName   (default: loop-engineering — must match selfUpdate's LOOP_WIN_SERVICE default)
    -Port          (default: 4711)
    -RequestDailyMax / -RequestWindowMax  (Copilot premium-request budget caps; 0 = unlimited)
    -PythonExe     (default: python — the company machine's Python 3.8.10 launcher)

  NOTE: Copilot CLI needs your org admin to have ENABLED the Copilot CLI policy on GitHub;
        Copilot Business alone is not enough. See docs.github.com/copilot .
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'loop-engineering',
  [int]$Port = 4711,
  [int]$RequestDailyMax = 0,
  [int]$RequestWindowMax = 0,
  [string]$PythonExe = 'python'
)
$ErrorActionPreference = 'Stop'

function Say ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "WARN $m" -ForegroundColor Yellow }
function Die ($m) { Write-Host "ERR  $m" -ForegroundColor Red; exit 1 }

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# --- 1. prerequisites ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'node not found — install Node.js >= 22 (Copilot CLI requires 22+).' }
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { Warn "Node $nodeMajor detected; the Copilot CLI needs >= 22. Upgrade if the copilot install fails." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git not found — install Git for Windows (also provides bash for verify steps).' }
if (-not (Get-Command $PythonExe -ErrorAction SilentlyContinue)) { Warn "$PythonExe not found — the PPTX/SSoT tooling will be disabled until Python 3.8+ is on PATH." }

# --- 2. build ---
Say 'installing deps + building'
Push-Location $Repo
try {
  npm ci
  npm run build
} finally { Pop-Location }

# --- 3. env file (create if missing; never overwrite an existing token) ---
$EnvDir = Join-Path $env:USERPROFILE '.config\loop-engineering'
$EnvFile = Join-Path $EnvDir 'env'
New-Item -ItemType Directory -Force -Path $EnvDir | Out-Null
if (-not (Test-Path $EnvFile)) {
  Say "writing $EnvFile"
  $bytes = New-Object 'System.Byte[]' 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, 32)
  @(
    "LOOP_PORT=$Port"
    'LOOP_BIND=127.0.0.1'
    "LOOP_API_TOKEN=$token"
    "# LOOP_WIN_SERVICE=$ServiceName   # service name used by self-update to restart"
    '# GITHUB_TOKEN=            # only for the work-item integration bridge, not the Copilot backend'
  ) | Set-Content -Encoding UTF8 $EnvFile
} else {
  Say "keeping existing $EnvFile"
}

# --- 4. GitHub Copilot CLI ---
if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) {
  Say 'installing GitHub Copilot CLI (@github/copilot)'
  npm install -g '@github/copilot'
} else {
  Say 'copilot CLI already installed'
}
Warn 'Copilot auth is a MANUAL one-time step (device code):'
Warn '  run:  copilot login   ->   open https://github.com/login/device and enter the code'
Warn '  (org admin must have enabled the Copilot CLI policy for your Copilot Business seat)'

# --- 5. python-pptx for the weekly-report tooling ---
if (Get-Command $PythonExe -ErrorAction SilentlyContinue) {
  Say 'installing python-pptx==1.0.2 (weekly-report PPTX renderer)'
  & $PythonExe -m pip install --user 'python-pptx==1.0.2'
}

# --- 6. Copilot-host config presets (live next tick; no restart needed) ---
Say 'applying Copilot-host config presets'
$loop = { param($k, $v) & npm run -s loop -- config set $k $v }
& $loop 'agent_backend' 'copilot-cli'
& $loop 'usage_provider' 'none'          # Copilot has no percent API -> disable percent budgeting
& $loop 'shell' 'auto'                    # win32 -> git-bash > PowerShell > cmd for verify steps
& $loop 'request_daily_max' "$RequestDailyMax"
& $loop 'request_window_max' "$RequestWindowMax"
if (Get-Command $PythonExe -ErrorAction SilentlyContinue) {
  & $loop 'ingest_openproject_python' $PythonExe
  & $loop 'report_pptx_python' $PythonExe
}

# --- 7. NSSM service (optional but recommended for unattended operation) ---
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if ($nssm) {
  Say "installing NSSM service '$ServiceName'"
  $logDir = Join-Path $env:LOCALAPPDATA 'loop-engineering\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  # remove a prior definition so re-runs are idempotent
  & nssm stop $ServiceName 2>$null | Out-Null
  & nssm remove $ServiceName confirm 2>$null | Out-Null
  & nssm install $ServiceName $node.Source (Join-Path $Repo 'dist\server.js')
  & nssm set $ServiceName AppDirectory $Repo
  & nssm set $ServiceName AppStdout (Join-Path $logDir 'service-out.log')
  & nssm set $ServiceName AppStderr (Join-Path $logDir 'service-err.log')
  & nssm set $ServiceName AppExit Default Restart
  & nssm set $ServiceName Start SERVICE_AUTO_START
  # env comes from the env file via loadEnvFile(); pin the service name so self-update restarts it
  & nssm set $ServiceName AppEnvironmentExtra "LOOP_WIN_SERVICE=$ServiceName"
  & nssm start $ServiceName
  Say "service '$ServiceName' started (auto-start on boot)."
} else {
  Warn 'nssm not found — install it (winget install nssm) then re-run, or start the engine manually:'
  Warn "  cd $Repo ; node dist\server.js"
}

Say 'done.'
Write-Host ''
Write-Host "  board:   http://127.0.0.1:$Port/?token=<LOOP_API_TOKEN from $EnvFile>"
Write-Host '  next:    run `copilot login` (device code) if you have not yet, then add a task with:'
Write-Host '           npm run loop -- add --tool mock ...   # smoke-test the engine first (zero tokens)'

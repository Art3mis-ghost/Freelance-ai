# Freelance AI Agent Hub — Unified Windows Startup Script
# Honors configured PORT/HOST from .env (BUG-01), launches node.exe directly, and verifies live PID + health.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$cfg = Get-HubEffectiveConfig
$RepoRoot = $cfg.RepoRoot
$PidFile = $cfg.PidFile
$LogDir = Join-Path $cfg.WorkspaceDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 1. Check existing recorded PID accurately
if ($cfg.PidInfo -and (Test-IsHubNodeProcess $cfg.PidInfo.Pid)) {
    $runningPort = if ($cfg.PidInfo.Port) { $cfg.PidInfo.Port } else { $cfg.Port }
    Write-Host "[INFO] Freelance AI Agent Hub is already running (Node PID $($cfg.PidInfo.Pid)) on http://$($cfg.HealthHost):$runningPort." -ForegroundColor Yellow
    if ($cfg.PidInfo.Port -and $cfg.PidInfo.Port -ne $cfg.Port) {
        Write-Host "       Note: .env PORT is $($cfg.Port) while running process uses port $($cfg.PidInfo.Port). Run .\scripts\stop.ps1 before restarting on port $($cfg.Port)." -ForegroundColor Yellow
    } else {
        Write-Host "       Open $($cfg.BaseUrl) or run .\scripts\stop.ps1 first." -ForegroundColor Yellow
    }
    exit 0
} elseif (Test-Path $PidFile) {
    Write-Host "[INFO] Removing stale .hub.pid file." -ForegroundColor Gray
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# 2. Check if configured PORT is already occupied by another service before starting
if (Test-TcpPortInUse $cfg.HealthHost $cfg.Port) {
    Write-Host "[ERROR] Port $($cfg.Port) on $($cfg.HealthHost) is already in use by another process." -ForegroundColor Red
    Write-Host "        Stop the conflicting process or change PORT in .env before starting." -ForegroundColor Yellow
    exit 1
}

# 3. Verify local tsx CLI exists for direct node.exe execution (no npm.cmd wrapper)
$tsxCli = Join-Path $RepoRoot "node_modules\tsx\dist\cli.mjs"
$serverEntry = Join-Path $RepoRoot "server.ts"
if (-not (Test-Path $tsxCli)) {
    Write-Host "[ERROR] tsx runtime not found at $tsxCli. Run .\scripts\install.ps1 first." -ForegroundColor Red
    exit 1
}

# 4. Check Ollama status (informational)
try {
    Invoke-RestMethod -Uri "$($cfg.OllamaBaseUrl)/api/tags" -TimeoutSec 2 | Out-Null
    Write-Host "[OK] Local Ollama detected at $($cfg.OllamaBaseUrl)" -ForegroundColor Green
} catch {
    Write-Host "[INFO] Local Ollama is not running at $($cfg.OllamaBaseUrl). You can start it anytime or use a fallback provider." -ForegroundColor Yellow
}

$env:NODE_ENV = "production"
$env:HUB_PID_FILE = $PidFile
$env:PORT = "$($cfg.Port)"
$env:HOST = "$($cfg.BindHost)"
$outLog = Join-Path $LogDir "server.out.log"
$errLog = Join-Path $LogDir "server.err.log"

Write-Host "Starting Freelance AI Agent Hub directly via node.exe on $($cfg.BaseUrl) (bind $($cfg.BindHost):$($cfg.Port)) ..." -ForegroundColor Cyan
$proc = Start-Process -FilePath "node" `
    -ArgumentList @($tsxCli, $serverEntry) `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru `
    -WindowStyle Hidden

# 5. Wait for BOTH process liveness, server-written PID verification, AND configured /api/health
$ready = $false
$serverPid = $proc.Id
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500

    # Fail fast if the launched Node process crashed during startup
    if ($proc.HasExited) {
        Write-Host "[ERROR] Server process (PID $($proc.Id)) exited unexpectedly with code $($proc.ExitCode)." -ForegroundColor Red
        if (Test-Path $errLog) {
            Write-Host "--- Recent error log ($errLog) ---" -ForegroundColor Yellow
            Get-Content $errLog -Tail 20
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        exit 1
    }

    try {
        $health = Invoke-RestMethod -Uri $cfg.HealthUrl -TimeoutSec 2
        $recorded = Get-RecordedHubPidInfo $PidFile
        if ($health.status -eq "ok" -and $recorded -and (Test-IsHubNodeProcess $recorded.Pid)) {
            $serverPid = $recorded.Pid
            $ready = $true
            break
        }
    } catch {
        # keep waiting
    }
}

if ($ready) {
    Write-Host "[OK] Freelance AI Agent Hub is live at $($cfg.BaseUrl) (Verified Node PID $serverPid)" -ForegroundColor Green
    Start-Process $cfg.BaseUrl
} else {
    Write-Host "[ERROR] Server did not pass verified PID + health checks on $($cfg.HealthUrl) within timeout. Cleaning up..." -ForegroundColor Red
    if (-not $proc.HasExited) {
        & taskkill /PID $proc.Id /T /F | Out-Null
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    if (Test-Path $errLog) {
        Write-Host "--- Recent error log ($errLog) ---" -ForegroundColor Yellow
        Get-Content $errLog -Tail 20
    }
    exit 1
}

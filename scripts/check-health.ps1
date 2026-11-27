# Freelance AI Agent Hub — Windows Health Check Script
# Reads effective PORT, HOST, DB_PATH, and OLLAMA_BASE_URL from .env / environment (BUG-01).

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")

$cfg = Get-HubEffectiveConfig
$targetPort = if ($cfg.PidInfo -and $cfg.PidInfo.Port) { $cfg.PidInfo.Port } else { $cfg.Port }
$targetHealthUrl = "http://$($cfg.HealthHost):$targetPort/api/health"

Write-Host "Checking Freelance AI Agent Hub health on $targetHealthUrl ..." -ForegroundColor Cyan

if ($cfg.PidInfo -and $cfg.PidInfo.Port -and $cfg.PidInfo.Port -ne $cfg.Port) {
    Write-Host "[WARN] Running server PID $($cfg.PidInfo.Pid) reports port $($cfg.PidInfo.Port), while .env configures PORT=$($cfg.Port)." -ForegroundColor Yellow
}

try {
    $health = Invoke-RestMethod -Uri $targetHealthUrl -TimeoutSec 5
    if ($health.status -eq "ok") {
        Write-Host "[OK] Server Status: ok (http://$($cfg.HealthHost):$targetPort)" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Unexpected health status: $($health.status)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[FAIL] Server is not reachable at $targetHealthUrl" -ForegroundColor Red
    exit 1
}

if ($cfg.PidInfo) {
    if (Test-IsHubNodeProcess $cfg.PidInfo.Pid) {
        Write-Host "[OK] Tracked Node PID: $($cfg.PidInfo.Pid) (port $targetPort, started $($cfg.PidInfo.StartedAt))" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Stale .hub.pid references non-running or non-Hub PID $($cfg.PidInfo.Pid)" -ForegroundColor Yellow
    }
}

try {
    $tags = Invoke-RestMethod -Uri "$($cfg.OllamaBaseUrl)/api/tags" -TimeoutSec 3
    Write-Host "[OK] Ollama Local AI: Online at $($cfg.OllamaBaseUrl) ($($tags.models.Count) model(s))" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Ollama Local AI: Offline at $($cfg.OllamaBaseUrl) (fallback provider or degraded review-required scaffold mode will be used)" -ForegroundColor Yellow
}

if (Test-Path $cfg.DbPath) {
    $sizeKb = [math]::Round((Get-Item $cfg.DbPath).Length / 1KB, 1)
    Write-Host "[OK] SQLite Database file present at $($cfg.DbPath) ($sizeKb KB)" -ForegroundColor Green
} else {
    Write-Host "[WARN] SQLite Database file not found at $($cfg.DbPath)" -ForegroundColor Yellow
}

Write-Host "Note: Detailed system diagnostics are protected behind authentication at http://$($cfg.HealthHost):$targetPort/api/system/diagnostics." -ForegroundColor Gray

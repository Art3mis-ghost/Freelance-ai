# Freelance AI Agent Hub — Windows Stop Script
# Reads configured PORT/PID info via common.ps1, verifies process identity, terminates process tree cleanly, and removes orphans.

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")

$cfg = Get-HubEffectiveConfig
$RepoRoot = $cfg.RepoRoot
$PidFile = $cfg.PidFile

function Stop-HubProcessTree([int]$TargetPid) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction SilentlyContinue
    if (-not $cim) {
        return $false
    }
    if ($cim.Name -notmatch '^node(\.exe)?$') {
        Write-Host "[WARN] PID $TargetPid belongs to '$($cim.Name)', not node.exe. Refusing to kill unrelated process." -ForegroundColor Yellow
        return $false
    }
    if ($cim.CommandLine -and $cim.CommandLine -notmatch 'server\.(ts|js)') {
        Write-Host "[WARN] Node PID $TargetPid does not match Freelance AI Agent Hub server.ts. Refusing to kill unrelated Node process." -ForegroundColor Yellow
        return $false
    }

    Write-Host "Stopping Freelance AI Agent Hub process tree (Node PID $TargetPid)..." -ForegroundColor Cyan
    & taskkill /PID $TargetPid /T 2>$null | Out-Null

    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 350
        if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
            Write-Host "[OK] Process tree $TargetPid exited gracefully." -ForegroundColor Green
            return $true
        }
    }

    Write-Host "Graceful shutdown timed out; force-terminating process tree $TargetPid..." -ForegroundColor Yellow
    & taskkill /PID $TargetPid /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 400
    return (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue))
}

$stoppedAny = $false
$recordedPid = if ($cfg.PidInfo) { $cfg.PidInfo.Pid } else { $null }
$effectivePort = if ($cfg.PidInfo -and $cfg.PidInfo.Port) { $cfg.PidInfo.Port } else { $cfg.Port }

if ($recordedPid) {
    if (Stop-HubProcessTree $recordedPid) {
        $stoppedAny = $true
    }
}

# Scan for any orphaned node.exe processes running this repo's server.ts
$escapedRoot = [regex]::Escape($RepoRoot)
$orphans = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and ($_.CommandLine -match $escapedRoot) -and ($_.CommandLine -match 'server\.(ts|js)')
}

foreach ($orphan in $orphans) {
    if ($orphan.ProcessId -ne $recordedPid) {
        Write-Host "[INFO] Found additional Hub server process (PID $($orphan.ProcessId)). Stopping..." -ForegroundColor Yellow
        if (Stop-HubProcessTree ([int]$orphan.ProcessId)) {
            $stoppedAny = $true
        }
    }
}

if (Test-Path $PidFile) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if (Test-TcpPortInUse $cfg.HealthHost $effectivePort) {
    Write-Host "[WARN] Port $effectivePort on $($cfg.HealthHost) is still occupied by another process." -ForegroundColor Yellow
} elseif ($stoppedAny) {
    Write-Host "[OK] Freelance AI Agent Hub stopped cleanly (port $effectivePort released)." -ForegroundColor Green
} else {
    Write-Host "[INFO] No running Freelance AI Agent Hub server processes were found (checked port $effectivePort)." -ForegroundColor Gray
}

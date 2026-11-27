# Freelance AI Agent Hub — Windows Local Diagnostics Script
# Reports Node runtime, build status, ports, backend/frontend health, SQLite DB health,
# AI providers reachability, job connectors, platform accounts, and workspace status.

$ErrorActionPreference = "Continue"

. (Join-Path $PSScriptRoot "common.ps1")

$cfg = Get-HubEffectiveConfig
$dotEnv = Read-DotEnvFile $cfg.EnvPath

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Freelance AI Agent Hub — System Diagnostics" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Repo Root     : $($cfg.RepoRoot)"
Write-Host "Bind / URL    : $($cfg.BindHost):$($cfg.Port) ($($cfg.BaseUrl))"
Write-Host "Workspace Dir : $($cfg.WorkspaceDir)"
Write-Host "Database Path : $($cfg.DbPath)"
Write-Host ""

# 1. Node.js & node:sqlite runtime check
Write-Host "[1/7] Runtime & Node.js" -ForegroundColor Yellow
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVerRaw = (& node -v).Trim()
    $verClean = $nodeVerRaw.TrimStart("v")
    $parts = $verClean.Split(".")
    $major = if ($parts.Length -ge 1) { [int]$parts[0] } else { 0 }
    $minor = if ($parts.Length -ge 2) { [int]$parts[1] } else { 0 }
    $nodeOk = ($major -gt 22) -or ($major -eq 22 -and $minor -ge 13)
    Write-Host ("  Node.js version : {0} ({1})" -f $nodeVerRaw, $(if ($nodeOk) { "OK >= 22.13" } else { "UPGRADE REQUIRED >= 22.13" })) -ForegroundColor $(if ($nodeOk) { "Green" } else { "Red" })
    $sqliteCheck = & node -e "import('node:sqlite').then(() => console.log('OK')).catch(() => console.log('MISSING'))" 2>$null
    Write-Host ("  node:sqlite API : {0}" -f $sqliteCheck) -ForegroundColor $(if ($sqliteCheck -eq "OK") { "Green" } else { "Red" })
} else {
    Write-Host "  Node.js         : NOT FOUND in PATH" -ForegroundColor Red
}

# 2. Project & Build Status
Write-Host ""
Write-Host "[2/7] Project & Build Status" -ForegroundColor Yellow
$hasEnv = Test-Path $cfg.EnvPath
$hasNodeModules = Test-Path (Join-Path $cfg.RepoRoot "node_modules")
$hasDist = Test-Path (Join-Path $cfg.RepoRoot "dist\index.html")
$hasLock = Test-Path (Join-Path $cfg.RepoRoot "package-lock.json")
Write-Host ("  .env file         : {0}" -f $(if ($hasEnv) { "Present" } else { "Missing (run scripts\install.cmd)" })) -ForegroundColor $(if ($hasEnv) { "Green" } else { "Yellow" })
Write-Host ("  node_modules      : {0}" -f $(if ($hasNodeModules) { "Installed" } else { "Missing (run npm ci)" })) -ForegroundColor $(if ($hasNodeModules) { "Green" } else { "Red" })
Write-Host ("  dist/index.html   : {0}" -f $(if ($hasDist) { "Built" } else { "Not built (run npm run build)" })) -ForegroundColor $(if ($hasDist) { "Green" } else { "Yellow" })
Write-Host ("  package-lock.json : {0}" -f $(if ($hasLock) { "Present" } else { "Missing" })) -ForegroundColor $(if ($hasLock) { "Green" } else { "Yellow" })

# 3. Backend & Frontend Health
Write-Host ""
Write-Host "[3/7] Server, Port & Frontend Health" -ForegroundColor Yellow
$portOpen = Test-TcpPortInUse $cfg.HealthHost $cfg.Port
Write-Host ("  Configured Port   : {0} ({1})" -f $cfg.Port, $(if ($portOpen) { "LISTENING" } else { "NOT LISTENING" })) -ForegroundColor $(if ($portOpen) { "Green" } else { "Yellow" })
if ($portOpen) {
    try {
        $health = Invoke-RestMethod -Uri $cfg.HealthUrl -TimeoutSec 5 -ErrorAction Stop
        Write-Host ("  Backend /api/health : OK (status={0}, mode={1})" -f $health.status, $health.mode) -ForegroundColor Green
    } catch {
        Write-Host ("  Backend /api/health : FAILED ({0})" -f $_.Exception.Message) -ForegroundColor Red
    }
    try {
        $front = Invoke-WebRequest -Uri $cfg.BaseUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Write-Host ("  Frontend HTTP /     : HTTP {0}" -f $front.StatusCode) -ForegroundColor Green
    } catch {
        Write-Host ("  Frontend HTTP /     : FAILED ({0})" -f $_.Exception.Message) -ForegroundColor Red
    }
}

# 4. SQLite Database Health & Domain Counts
Write-Host ""
Write-Host "[4/7] SQLite Database, Platform Accounts & Connectors" -ForegroundColor Yellow
if (Test-Path $cfg.DbPath) {
    $dbSizeKb = [math]::Round(((Get-Item $cfg.DbPath).Length / 1KB), 1)
    Write-Host ("  Database File     : Present ({0} KB)" -f $dbSizeKb) -ForegroundColor Green
    if ($nodeCmd) {
        $inspectScript = @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const integrity = db.prepare('PRAGMA integrity_check').get();
const mig = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
const safeCount = (sql) => { try { return Number(db.prepare(sql).get().c || 0); } catch { return -1; } };
const summary = {
  integrity: integrity?.integrity_check || 'unknown',
  schemaVersion: mig?.v || 0,
  jobs: safeCount('SELECT COUNT(*) as c FROM jobs'),
  projects: safeCount('SELECT COUNT(*) as c FROM projects'),
  deliveries: safeCount('SELECT COUNT(*) as c FROM delivery_records'),
  pendingApprovals: safeCount("SELECT COUNT(*) as c FROM approvals WHERE status = 'pending'"),
  connectorsEnabled: safeCount('SELECT COUNT(*) as c FROM sources WHERE enabled = 1'),
  platformsTotal: safeCount('SELECT COUNT(*) as c FROM platform_accounts'),
  platformsConnected: safeCount("SELECT COUNT(*) as c FROM platform_accounts WHERE enabled = 1 AND status = 'connected'"),
  providersEnabled: safeCount('SELECT COUNT(*) as c FROM ai_providers WHERE enabled = 1')
};
console.log(JSON.stringify(summary));
db.close();
"@
        $rawSummary = & node -e $inspectScript $cfg.DbPath 2>$null
        if ($rawSummary) {
            try {
                $s = $rawSummary | ConvertFrom-Json
                Write-Host ("  Integrity Check   : {0} (Schema v{1})" -f $s.integrity, $s.schemaVersion) -ForegroundColor $(if ($s.integrity -eq "ok") { "Green" } else { "Red" })
                Write-Host ("  Records           : Jobs={0}, Projects={1}, Deliveries={2}, PendingApprovals={3}" -f $s.jobs, $s.projects, $s.deliveries, $s.pendingApprovals)
                Write-Host ("  Job Connectors    : {0} enabled" -f $s.connectorsEnabled)
                Write-Host ("  Platform Accounts : {0} connected / {1} registered" -f $s.platformsConnected, $s.platformsTotal)
                Write-Host ("  AI Providers DB   : {0} enabled" -f $s.providersEnabled)
            } catch {
                Write-Host "  DB Inspection     : Unable to parse summary JSON" -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host "  Database File     : Not created yet (run npm run db:init)" -ForegroundColor Yellow
}

# 5. Local AI Providers Reachability
Write-Host ""
Write-Host "[5/7] Local AI Providers Health" -ForegroundColor Yellow
$ollamaHealthUrl = "$($cfg.OllamaBaseUrl)/api/tags"
try {
    $ol = Invoke-WebRequest -Uri $ollamaHealthUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    Write-Host ("  Ollama ({0}) : REACHABLE (HTTP {1})" -f $cfg.OllamaBaseUrl, $ol.StatusCode) -ForegroundColor Green
} catch {
    Write-Host ("  Ollama ({0}) : Offline or not started" -f $cfg.OllamaBaseUrl) -ForegroundColor Yellow
}

$freeLlmUrl = if ($env:FREELLM_BASE_URL) { $env:FREELLM_BASE_URL } elseif ($dotEnv["FREELLM_BASE_URL"]) { $dotEnv["FREELLM_BASE_URL"] } else { "http://127.0.0.1:31415/v1" }
$freeLlmProbe = "$($freeLlmUrl.TrimEnd('/'))/models"
try {
    $fl = Invoke-WebRequest -Uri $freeLlmProbe -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    Write-Host ("  FreeLLMAPI ({0}) : REACHABLE (HTTP {1})" -f $freeLlmUrl, $fl.StatusCode) -ForegroundColor Green
} catch {
    Write-Host ("  FreeLLMAPI ({0}) : Not reachable right now" -f $freeLlmUrl) -ForegroundColor Yellow
}

# 6. Workspace Status
Write-Host ""
Write-Host "[6/7] Workspace Directory" -ForegroundColor Yellow
if (Test-Path $cfg.WorkspaceDir) {
    $projectsDir = Join-Path $cfg.WorkspaceDir "projects"
    $projFolders = if (Test-Path $projectsDir) { (Get-ChildItem $projectsDir -Directory -ErrorAction SilentlyContinue).Count } else { 0 }
    Write-Host ("  Workspace Root    : Ready ({0} project workspace folder(s))" -f $projFolders) -ForegroundColor Green
} else {
    Write-Host "  Workspace Root    : Not created yet (will be created on first start)" -ForegroundColor Yellow
}

# 7. Next Steps Hint
Write-Host ""
Write-Host "[7/7] Operator Commands" -ForegroundColor Yellow
Write-Host "  Start Hub         : .\scripts\start.cmd"
Write-Host "  Stop Hub          : .\scripts\stop.cmd"
Write-Host "  Health Check      : .\scripts\check-health.cmd"
Write-Host "  Consistent Backup : .\scripts\backup.cmd"
Write-Host "  Run Test Suite    : npm test"
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

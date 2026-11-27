# Freelance AI Agent Hub — Windows 10/11 Installation Script
# Resolves repo root safely (BUG-09), checks Node >= 22.13.0 + node:sqlite runtime API (BUG-02),
# generates persistent secrets outside DB, installs dependencies, builds UI, and initializes SQLite.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$RepoRoot = Get-HubRepoRoot
Push-Location $RepoRoot

try {
    Write-Host "====================================================" -ForegroundColor Cyan
    Write-Host "  Freelance AI Agent Hub - Windows Local Installer  " -ForegroundColor Cyan
    Write-Host "====================================================" -ForegroundColor Cyan
    Write-Host "[OK] Repository root: $RepoRoot" -ForegroundColor Green

    # 1. Check Node.js >= 22.13.0 (required by Vite 8 >=22.12.0 and built-in unflagged node:sqlite)
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] Node.js is not installed. Please install Node.js 22.13+ LTS from https://nodejs.org/" -ForegroundColor Red
        exit 1
    }

    $nodeVersionRaw = (node -v).Trim().TrimStart("v")
    $versionParts = $nodeVersionRaw.Split(".")
    $nodeMajor = [int]$versionParts[0]
    $nodeMinor = if ($versionParts.Length -ge 2) { [int]$versionParts[1] } else { 0 }
    $minMajor = 22
    $minMinor = 13

    if (($nodeMajor -lt $minMajor) -or ($nodeMajor -eq $minMajor -and $nodeMinor -lt $minMinor)) {
        Write-Host "[ERROR] Node.js v$nodeVersionRaw detected. Node.js v${minMajor}.${minMinor}.0 or newer is required (Vite 8 + built-in node:sqlite)." -ForegroundColor Red
        Write-Host "Download the latest Node.js 22 LTS from: https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[OK] Node.js v$nodeVersionRaw meets minimum version requirement (>= v${minMajor}.${minMinor}.0)." -ForegroundColor Green

    # 2. Probe actual runtime APIs (node:sqlite DatabaseSync + crypto.scryptSync) instead of trusting version string alone
    $probeScript = "import('node:sqlite').then(m => { if (typeof m.DatabaseSync !== 'function') process.exit(2); const db = new m.DatabaseSync(':memory:'); db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (42);'); const r = db.prepare('SELECT x FROM t').get(); db.close(); if (!r || r.x !== 42) process.exit(3); }).catch(e => { console.error(e && e.message ? e.message : e); process.exit(1); });"
    & node -e $probeScript 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Installed Node.js v$nodeVersionRaw failed the built-in node:sqlite DatabaseSync runtime probe (exit $LASTEXITCODE)." -ForegroundColor Red
        Write-Host "        Upgrade to the latest Node.js 22 LTS release from https://nodejs.org/." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[OK] Verified Node.js built-in node:sqlite (DatabaseSync) runtime API." -ForegroundColor Green

    # 3. Check npm
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] npm not found on PATH." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] npm $(npm -v) detected." -ForegroundColor Green

    # 4. Detect Ollama (never silently install third-party software)
    $ollamaUrl = "http://127.0.0.1:11434"
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        Write-Host "[OK] Ollama detected on system PATH." -ForegroundColor Green
        try {
            $tags = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -TimeoutSec 3
            Write-Host "[OK] Ollama service is running ($($tags.models.Count) local model(s) installed)." -ForegroundColor Green
        } catch {
            Write-Host "[INFO] Ollama is installed but not currently responding on $ollamaUrl." -ForegroundColor Yellow
            Write-Host "       Start Ollama or run: ollama serve" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[INFO] Ollama is NOT installed. Local AI models require Ollama." -ForegroundColor Yellow
        Write-Host "       To install Ollama manually on Windows:" -ForegroundColor Yellow
        Write-Host "       1. Download from https://ollama.com/download/windows" -ForegroundColor Gray
        Write-Host "       2. Run: ollama pull llama3.1:8b" -ForegroundColor Gray
        Write-Host "       (You can also configure optional external fallback providers in Settings.)" -ForegroundColor Gray
    }

    # 5. Optional Python check
    if (Get-Command python -ErrorAction SilentlyContinue) {
        Write-Host "[OK] Python detected: $(python --version)" -ForegroundColor Green
    } else {
        Write-Host "[INFO] Python not found (optional; Node.js handles DOCX/XLSX/PDF/PPTX/ZIP natively)." -ForegroundColor Gray
    }

    # Helper to generate cryptographically random hex string via Node crypto
    function New-RandomHex([int]$ByteLength) {
        return (node -e "console.log(require('crypto').randomBytes($ByteLength).toString('hex'))").Trim()
    }

    # 6. Create .env from .env.example inside $RepoRoot and ensure persistent encryption key + setup token exist (never overwrite existing keys!)
    $envFilePath = Join-Path $RepoRoot ".env"
    $envExamplePath = Join-Path $RepoRoot ".env.example"
    $generatedSetupToken = $null
    if (-not (Test-Path $envFilePath)) {
        if (-not (Test-Path $envExamplePath)) {
            Write-Host "[ERROR] .env.example not found at $envExamplePath." -ForegroundColor Red
            exit 1
        }
        Copy-Item $envExamplePath $envFilePath
        Write-Host "[OK] Created .env from .env.example (default bind: 127.0.0.1)." -ForegroundColor Green
    } else {
        Write-Host "[OK] Existing .env preserved." -ForegroundColor Green
    }

    $envContent = Get-Content $envFilePath -Raw

    if ($envContent -match '(?m)^HUB_SECRET_ENCRYPTION_KEY=\s*$') {
        $encKey = New-RandomHex 32
        $envContent = [regex]::Replace($envContent, '(?m)^HUB_SECRET_ENCRYPTION_KEY=\s*$', "HUB_SECRET_ENCRYPTION_KEY=$encKey")
        Write-Host "[OK] Generated persistent HUB_SECRET_ENCRYPTION_KEY in .env (stored outside SQLite database)." -ForegroundColor Green
    } elseif ($envContent -notmatch '(?m)^HUB_SECRET_ENCRYPTION_KEY=.+') {
        $encKey = New-RandomHex 32
        $envContent = $envContent.TrimEnd() + "`nHUB_SECRET_ENCRYPTION_KEY=$encKey`n"
        Write-Host "[OK] Added persistent HUB_SECRET_ENCRYPTION_KEY to .env." -ForegroundColor Green
    } else {
        Write-Host "[OK] Existing HUB_SECRET_ENCRYPTION_KEY preserved." -ForegroundColor Green
    }

    if ($envContent -match '(?m)^HUB_SETUP_TOKEN=\s*$') {
        $generatedSetupToken = New-RandomHex 16
        $envContent = [regex]::Replace($envContent, '(?m)^HUB_SETUP_TOKEN=\s*$', "HUB_SETUP_TOKEN=$generatedSetupToken")
        Write-Host "[OK] Generated first-run HUB_SETUP_TOKEN in .env." -ForegroundColor Green
    } elseif ($envContent -notmatch '(?m)^HUB_SETUP_TOKEN=.+') {
        $generatedSetupToken = New-RandomHex 16
        $envContent = $envContent.TrimEnd() + "`nHUB_SETUP_TOKEN=$generatedSetupToken`n"
        Write-Host "[OK] Added first-run HUB_SETUP_TOKEN to .env." -ForegroundColor Green
    }

    Set-Content -Path $envFilePath -Value $envContent -Encoding utf8

    # Restrict .env file permissions to the current Windows user only
    try {
        icacls $envFilePath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
        Write-Host "[OK] Restricted .env permissions to current user ($($env:USERNAME))." -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Could not tighten ACL on .env automatically. Keep .env private." -ForegroundColor Yellow
    }

    # 7. Install npm dependencies reproducibly via npm ci when package-lock.json is present
    $lockFile = Join-Path $RepoRoot "package-lock.json"
    if (Test-Path $lockFile) {
        Write-Host "`nInstalling locked Node.js dependencies (npm ci)..." -ForegroundColor Cyan
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    } else {
        Write-Host "`nInstalling Node.js dependencies (npm install)..." -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    }

    # 8. Build frontend production bundle
    Write-Host "`nBuilding frontend production assets..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }

    # 9. Initialize SQLite database & isolated workspace folders
    Write-Host "`nInitializing SQLite database and FreelanceAgentHub workspace..." -ForegroundColor Cyan
    npm run db:init
    if ($LASTEXITCODE -ne 0) { throw "npm run db:init failed with exit code $LASTEXITCODE" }

    Write-Host "`n====================================================" -ForegroundColor Green
    Write-Host "  Installation complete!                            " -ForegroundColor Green
    Write-Host "  Run .\scripts\start.ps1 to launch the Hub.        " -ForegroundColor Green
    if ($generatedSetupToken) {
        Write-Host "  First-Run Setup Token: $generatedSetupToken" -ForegroundColor Yellow
        Write-Host "  (Also saved privately inside your local .env file)" -ForegroundColor Gray
    }
    Write-Host "  Tip: Back up your encryption key separately via:  " -ForegroundColor Gray
    Write-Host "       .\scripts\backup.ps1 -PromptForKeyBackup     " -ForegroundColor Gray
    Write-Host "====================================================" -ForegroundColor Green
} finally {
    Pop-Location
}

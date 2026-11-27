# Freelance AI Agent Hub — SQLite-Consistent Windows Backup Script
# Uses SQLite online backup + PRAGMA integrity_check (BUG-03), includes restore manifest & sanitized runtime config (BUG-08),
# protects backup archives via icacls, and supports a separately encrypted encryption-key backup (BUG-05).

param(
    [string]$OutputArchive = "",
    [string]$BackupKeyPassphrase = "",
    [switch]$PromptForKeyBackup
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$cfg = Get-HubEffectiveConfig
$RepoRoot = $cfg.RepoRoot
$tsxCli = Join-Path $RepoRoot "node_modules\tsx\dist\cli.mjs"
$backupCli = Join-Path $RepoRoot "src\server\db\backup.ts"

if (-not (Test-Path $tsxCli)) {
    Write-Host "[ERROR] tsx runtime not found at $tsxCli. Run .\scripts\install.ps1 first." -ForegroundColor Red
    exit 1
}

Push-Location $RepoRoot
try {
    Write-Host "Creating SQLite WAL-consistent verified backup..." -ForegroundColor Cyan

    $argsList = @($tsxCli, $backupCli, "--json")
    if ($OutputArchive) {
        $argsList += @("--output", $OutputArchive)
    }

    $jsonOutput = & node @argsList
    if ($LASTEXITCODE -ne 0) {
        throw "SQLite backup CLI failed with exit code $LASTEXITCODE"
    }

    $result = ($jsonOutput -join "`n").Trim() | ConvertFrom-Json
    $archivePath = $result.archivePath

    # Restrict archive permissions to current Windows user only (contains project & client data)
    try {
        icacls $archivePath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
        Write-Host "[OK] Restricted backup archive ACL to current user ($($env:USERNAME))." -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Could not tighten ACL on $archivePath automatically. Store backup securely." -ForegroundColor Yellow
    }

    Write-Host "[OK] Verified backup archive created: $archivePath" -ForegroundColor Green
    Write-Host "     SQLite Method: $($result.backupMethod) | Integrity: $($result.integrityCheck) | FK Violations: $($result.foreignKeyViolations)" -ForegroundColor Green
    Write-Host "     Projects: $($result.projectsCount) | Runtime Logs: $($result.runtimeLogsCount) | SHA-256: $($result.archiveSha256)" -ForegroundColor Gray
    Write-Host "     Includes: data/hub.db, projects/, logs/, config/non_secret_config.json, backup_manifest.json, RESTORE_INSTRUCTIONS.md" -ForegroundColor Gray

    # Optional separate passphrase-encrypted key backup (NEVER bundled inside the main data ZIP)
    $keyPass = $BackupKeyPassphrase
    if ($PromptForKeyBackup -and -not $keyPass) {
        $secPass = Read-Host "Enter a recovery passphrase (>= 12 chars) for separate encrypted key backup" -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPass)
        try {
            $keyPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    if ($keyPass) {
        $prevPassEnv = $env:HUB_KEY_BACKUP_PASSPHRASE
        $env:HUB_KEY_BACKUP_PASSPHRASE = $keyPass
        try {
            $keyOut = & node $tsxCli $backupCli --key-only
            if ($LASTEXITCODE -ne 0) {
                throw "Encrypted key backup failed with exit code $LASTEXITCODE"
            }
            $keyResult = ($keyOut -join "`n").Trim() | ConvertFrom-Json
            try {
                icacls $keyResult.outputPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
            } catch {
                # best effort
            }
            Write-Host "[OK] Separate encrypted encryption-key backup created: $($keyResult.outputPath)" -ForegroundColor Green
            Write-Host "     Key Fingerprint Prefix: $($keyResult.fingerprintSha256Prefix) (store this file SEPARATELY from the data ZIP!)" -ForegroundColor Yellow
        } finally {
            $env:HUB_KEY_BACKUP_PASSPHRASE = $prevPassEnv
        }
    } else {
        Write-Host "[INFO] Encryption key & .env secrets are intentionally excluded from the data ZIP." -ForegroundColor Yellow
        Write-Host "       To back up your encryption key separately for full disaster recovery, run:" -ForegroundColor Gray
        Write-Host "       .\scripts\backup.ps1 -PromptForKeyBackup" -ForegroundColor Gray
    }
} finally {
    Pop-Location
}

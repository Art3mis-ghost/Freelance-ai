# Freelance AI Agent Hub — Shared PowerShell Configuration & Process Helpers
# Resolves repository root, .env settings (PORT, HOST, WORKSPACE_DIR, DB_PATH, OLLAMA_BASE_URL), and verified Hub PID info.

function Get-HubRepoRoot {
    $root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    if (-not (Test-Path (Join-Path $root "package.json"))) {
        throw "Could not locate repository root (package.json not found at $root)."
    }
    return $root
}

function Read-DotEnvFile([string]$EnvPath) {
    $map = @{}
    if (-not (Test-Path $EnvPath)) { return $map }
    foreach ($line in (Get-Content $EnvPath -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $eqIdx = $trimmed.IndexOf("=")
        if ($eqIdx -lt 1) { continue }
        $key = $trimmed.Substring(0, $eqIdx).Trim()
        $val = $trimmed.Substring($eqIdx + 1).Trim()
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            if ($val.Length -ge 2) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        $map[$key] = $val
    }
    return $map
}

function Get-RecordedHubPidInfo([string]$PidFilePath) {
    if (-not (Test-Path $PidFilePath)) { return $null }
    $raw = Get-Content $PidFilePath -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $trimmed = $raw.Trim()
    try {
        $obj = $trimmed | ConvertFrom-Json -ErrorAction Stop
        if ($obj.pid) {
            return [PSCustomObject]@{
                Pid       = [int]$obj.pid
                Host      = if ($obj.host) { [string]$obj.host } else { $null }
                Port      = if ($obj.port) { [int]$obj.port } else { $null }
                StartedAt = if ($obj.startedAt) { [string]$obj.startedAt } else { $null }
            }
        }
    } catch {
        if ($trimmed -match '^\d+$') {
            return [PSCustomObject]@{
                Pid       = [int]$trimmed
                Host      = $null
                Port      = $null
                StartedAt = $null
            }
        }
    }
    return $null
}

function Get-HubEffectiveConfig {
    $repoRoot = Get-HubRepoRoot
    $envPath = Join-Path $repoRoot ".env"
    $dotEnv = Read-DotEnvFile $envPath

    $pidFileRaw = if ($env:HUB_PID_FILE) { $env:HUB_PID_FILE } elseif ($dotEnv["HUB_PID_FILE"]) { $dotEnv["HUB_PID_FILE"] } else { ".hub.pid" }
    $pidFile = if ([System.IO.Path]::IsPathRooted($pidFileRaw)) { $pidFileRaw } else { Join-Path $repoRoot $pidFileRaw }
    $pidInfo = Get-RecordedHubPidInfo $pidFile

    $portRaw = if ($env:PORT) { $env:PORT } elseif ($dotEnv["PORT"]) { $dotEnv["PORT"] } else { "3000" }
    $port = 3000
    if (-not [int]::TryParse($portRaw, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        $port = 3000
    }

    $bindHost = if ($env:HOST) { $env:HOST } elseif ($dotEnv["HOST"]) { $dotEnv["HOST"] } else { "127.0.0.1" }
    $healthHost = if ($bindHost -eq "0.0.0.0" -or $bindHost -eq "::" -or -not $bindHost) { "127.0.0.1" } else { $bindHost }

    $wsRaw = if ($env:WORKSPACE_DIR) { $env:WORKSPACE_DIR } elseif ($dotEnv["WORKSPACE_DIR"]) { $dotEnv["WORKSPACE_DIR"] } else { "./FreelanceAgentHub" }
    $workspaceDir = if ([System.IO.Path]::IsPathRooted($wsRaw)) { $wsRaw } else { [System.IO.Path]::GetFullPath((Join-Path $repoRoot $wsRaw)) }

    $dbRaw = if ($env:DB_PATH) { $env:DB_PATH } elseif ($dotEnv["DB_PATH"]) { $dotEnv["DB_PATH"] } else { Join-Path $workspaceDir "data\hub.db" }
    $dbPath = if ([System.IO.Path]::IsPathRooted($dbRaw)) { $dbRaw } else { [System.IO.Path]::GetFullPath((Join-Path $repoRoot $dbRaw)) }

    $ollamaUrl = if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL } elseif ($dotEnv["OLLAMA_BASE_URL"]) { $dotEnv["OLLAMA_BASE_URL"] } else { "http://127.0.0.1:11434" }

    return [PSCustomObject]@{
        RepoRoot      = $repoRoot
        EnvPath       = $envPath
        PidFile       = $pidFile
        PidInfo       = $pidInfo
        BindHost      = $bindHost
        HealthHost    = $healthHost
        Port          = $port
        BaseUrl       = "http://${healthHost}:${port}"
        HealthUrl     = "http://${healthHost}:${port}/api/health"
        WorkspaceDir  = $workspaceDir
        DbPath        = $dbPath
        OllamaBaseUrl = $ollamaUrl.TrimEnd("/")
    }
}

function Test-IsHubNodeProcess([int]$TargetPid) {
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction Stop
        if (-not $cim) { return $false }
        if ($cim.Name -notmatch '^node(\.exe)?$') { return $false }
        if ($cim.CommandLine -and $cim.CommandLine -notmatch 'server\.(ts|js)') { return $false }
        return $true
    } catch {
        return $false
    }
}

function Test-TcpPortInUse([string]$TargetHost, [int]$TargetPort) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($TargetHost, $TargetPort, $null, $null)
        $connected = $async.AsyncWaitHandle.WaitOne(400, $false)
        if ($connected -and $client.Connected) {
            $client.EndConnect($async)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}

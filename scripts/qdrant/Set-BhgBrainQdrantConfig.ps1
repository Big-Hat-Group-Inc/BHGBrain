#requires -Version 5.1
<#
.SYNOPSIS
    Point BHGBrain at an external (e.g. Qdrant Cloud) vector database.

.DESCRIPTION
    Updates BHGBrain's config.json to use an external Qdrant cluster and (unless
    -SkipEnv) persists the API key to the QDRANT_API_KEY user environment variable.

    Sets, under qdrant:
      mode          = external
      external_url  = <Url>
      api_key_env   = <ApiKeyEnv>   (null-able; set when the cluster needs a key)

    NOTE: BHGBrain has no in-process/"embedded" Qdrant. Any mode other than
    'external' makes the client talk to http://localhost:6333. Use this script to
    switch to a managed cluster so vector storage actually works.

.PARAMETER Url
    Cluster REST endpoint, e.g. https://xxxxxxxx-xxxx.eastus-0.azure.cloud.qdrant.io:6333

.PARAMETER ApiKey
    Cluster API key. Persisted to the env var named by -ApiKeyEnv unless -SkipEnv.

.PARAMETER ApiKeyEnv
    Name of the env var BHGBrain reads the key from. Default: QDRANT_API_KEY

.PARAMETER ConfigPath
    Path to config.json. Default: %LOCALAPPDATA%\BHGBrain\config.json

.PARAMETER SkipEnv
    Do not write the API key to the environment (only edit config.json).

.EXAMPLE
    ./Set-BhgBrainQdrantConfig.ps1 -Url "https://abc123.eastus-0.azure.cloud.qdrant.io:6333" -ApiKey $key
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Url,
    [string]$ApiKey,
    [string]$ApiKeyEnv  = 'QDRANT_API_KEY',
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'BHGBrain\config.json'),
    [switch]$SkipEnv
)

$ErrorActionPreference = 'Stop'

if ($Url -notmatch '^https?://') {
    throw "Url '$Url' must start with http:// or https://"
}

if (-not (Test-Path $ConfigPath)) {
    throw "Config not found at '$ConfigPath'. Run BHGBrain once to generate it, or pass -ConfigPath."
}

$backup = "$ConfigPath.bak"
Copy-Item -Path $ConfigPath -Destination $backup -Force
Write-Host "Backed up existing config to $backup"

$cfg = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
if (-not $cfg.qdrant) {
    throw "Config at '$ConfigPath' has no 'qdrant' section - is this a BHGBrain config?"
}

$cfg.qdrant.mode         = 'external'
$cfg.qdrant.external_url = $Url
$cfg.qdrant.api_key_env  = $ApiKeyEnv

$cfg | ConvertTo-Json -Depth 30 | Set-Content -Path $ConfigPath -Encoding utf8
Write-Host "Updated ${ConfigPath}:" -ForegroundColor Green
Write-Host "  qdrant.mode         = external"
Write-Host "  qdrant.external_url = $Url"
Write-Host "  qdrant.api_key_env  = $ApiKeyEnv"

if ($SkipEnv) {
    Write-Host "Skipping env var (--SkipEnv). Set $ApiKeyEnv yourself before starting BHGBrain." -ForegroundColor Yellow
} elseif ($ApiKey) {
    [System.Environment]::SetEnvironmentVariable($ApiKeyEnv, $ApiKey, 'User')
    Set-Item -Path "Env:\$ApiKeyEnv" -Value $ApiKey
    Write-Host "Persisted $ApiKeyEnv to the User environment (and current session)." -ForegroundColor Green
    Write-Host "Open a NEW terminal for other apps to see it." -ForegroundColor Yellow
} else {
    Write-Host "No -ApiKey supplied; config updated but $ApiKeyEnv not set." -ForegroundColor Yellow
    Write-Host "Set it before starting BHGBrain: setx $ApiKeyEnv <your-key>"
}

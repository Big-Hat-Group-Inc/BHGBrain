#requires -Version 5.1
<#
.SYNOPSIS
    Point BHGBrain at an Azure AI Foundry / Azure OpenAI embedding deployment.

.DESCRIPTION
    Updates the BHGBrain config.json to use the `azure-foundry` embedding provider
    and (unless -SkipEnv) persists the API key to the AZURE_FOUNDRY_API_KEY user
    environment variable.

    Sets, under embedding:
      provider    = azure-foundry
      model       = <Model>
      dimensions  = <Dimensions>
      azure       = { resource_name = <ResourceName>, api_key_env = <ApiKeyEnv> }

    The resource_name is the `<name>.openai.azure.com` subdomain == your Azure
    account name. These values must match the deployment created by
    Deploy-AzureFoundry.ps1 (deployment name == model name).

.PARAMETER ResourceName
    Azure account name / openai.azure.com subdomain. Lowercase letters/numbers/hyphens.

.PARAMETER Model
    Deployed embedding model name (also the deployment name). Default: text-embedding-3-small

.PARAMETER Dimensions
    Embedding dimensions. Default: 1536

.PARAMETER ApiKey
    The Azure key. Persisted to the env var named by -ApiKeyEnv unless -SkipEnv.

.PARAMETER ApiKeyEnv
    Name of the env var BHGBrain reads the key from. Default: AZURE_FOUNDRY_API_KEY

.PARAMETER ConfigPath
    Path to config.json. Default: %LOCALAPPDATA%\BHGBrain\config.json

.PARAMETER SkipEnv
    Do not write the API key to the environment (only edit config.json).

.EXAMPLE
    ./Set-BhgBrainAzureConfig.ps1 -ResourceName bhgbrain-foundry -ApiKey $key
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ResourceName,
    [string]$Model      = 'text-embedding-3-small',
    [int]$Dimensions    = 1536,
    [string]$ApiKey,
    [string]$ApiKeyEnv  = 'AZURE_FOUNDRY_API_KEY',
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'BHGBrain\config.json'),
    [switch]$SkipEnv
)

$ErrorActionPreference = 'Stop'

$ResourceName = $ResourceName.ToLowerInvariant()
if ($ResourceName -notmatch '^[a-z0-9-]+$') {
    throw "ResourceName '$ResourceName' must contain only lowercase letters, numbers, and hyphens."
}

if (-not (Test-Path $ConfigPath)) {
    throw "Config not found at '$ConfigPath'. Run BHGBrain once to generate it, or pass -ConfigPath."
}

# Back up before editing.
$backup = "$ConfigPath.bak"
Copy-Item -Path $ConfigPath -Destination $backup -Force
Write-Host "Backed up existing config to $backup"

$cfg = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json

if (-not $cfg.embedding) {
    throw "Config at '$ConfigPath' has no 'embedding' section - is this a BHGBrain config?"
}

$cfg.embedding.provider   = 'azure-foundry'
$cfg.embedding.model      = $Model
$cfg.embedding.dimensions = $Dimensions

$azure = [PSCustomObject]@{ resource_name = $ResourceName; api_key_env = $ApiKeyEnv }
if ($cfg.embedding.PSObject.Properties.Name -contains 'azure') {
    $cfg.embedding.azure = $azure
} else {
    $cfg.embedding | Add-Member -NotePropertyName 'azure' -NotePropertyValue $azure
}

$cfg | ConvertTo-Json -Depth 30 | Set-Content -Path $ConfigPath -Encoding utf8
Write-Host "Updated ${ConfigPath}:" -ForegroundColor Green
Write-Host "  embedding.provider           = azure-foundry"
Write-Host "  embedding.model              = $Model"
Write-Host "  embedding.dimensions         = $Dimensions"
Write-Host "  embedding.azure.resource_name= $ResourceName"
Write-Host "  embedding.azure.api_key_env  = $ApiKeyEnv"

if ($SkipEnv) {
    Write-Host "Skipping env var (--SkipEnv). Set $ApiKeyEnv yourself before starting BHGBrain." -ForegroundColor Yellow
} elseif ($ApiKey) {
    [System.Environment]::SetEnvironmentVariable($ApiKeyEnv, $ApiKey, 'User')
    # Also set in the current session so an immediate run works.
    Set-Item -Path "Env:\$ApiKeyEnv" -Value $ApiKey
    Write-Host "Persisted $ApiKeyEnv to the User environment (and current session)." -ForegroundColor Green
    Write-Host "Open a NEW terminal for other apps to see it." -ForegroundColor Yellow
} else {
    Write-Host "No -ApiKey supplied; config updated but $ApiKeyEnv not set." -ForegroundColor Yellow
    Write-Host "Set it before starting BHGBrain: setx $ApiKeyEnv <your-key>"
}

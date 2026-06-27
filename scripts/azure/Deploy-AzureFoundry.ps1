#requires -Version 5.1
<#
.SYNOPSIS
    Provision an Azure AI Foundry / Azure OpenAI resource and deploy an embedding
    model for use with BHGBrain's `azure-foundry` embedding provider.

.DESCRIPTION
    Starts from nothing but an Azure subscription and creates, idempotently:
      1. A resource group
      2. A Cognitive Services account (kind OpenAI by default) with a custom
         subdomain == the account name, so the `<name>.openai.azure.com` endpoint
         BHGBrain expects resolves and key-based auth works.
      3. An embedding model deployment whose *deployment name equals the model
         name* (BHGBrain sends the model name in the request body, so the two
         MUST match).

    On success it prints the values BHGBrain needs and, unless -SkipBhgBrainConfig
    is given, writes them into your BHGBrain config.json and persists the API key
    to the AZURE_FOUNDRY_API_KEY user environment variable via
    Set-BhgBrainAzureConfig.ps1.

    Requires the Azure CLI (`az`). Install: https://aka.ms/installazurecli

.PARAMETER SubscriptionId
    Subscription to deploy into. Defaults to your currently active az subscription.

.PARAMETER ResourceGroup
    Resource group name. Created if missing. Default: rg-bhgbrain

.PARAMETER Location
    Azure region. Must support the chosen embedding model. Default: eastus
    (text-embedding-3-small/large are widely available in eastus, eastus2,
    westus3, etc. — see the README if creation fails on capacity.)

.PARAMETER AccountName
    Cognitive Services account name AND the global `<name>.openai.azure.com`
    subdomain. Must be globally unique, 2-64 chars, lowercase letters/numbers/
    hyphens. Default: bhgbrain-foundry (change it if taken).

.PARAMETER Kind
    OpenAI (classic Azure OpenAI, guarantees the .openai.azure.com endpoint) or
    AIServices (unified Azure AI Foundry resource). Default: OpenAI

.PARAMETER Model
    Embedding model to deploy. Default: text-embedding-3-small

.PARAMETER ModelVersion
    Model version. Default: 1

.PARAMETER Dimensions
    Embedding dimensions written to BHGBrain config. Auto-selected from the model
    when omitted (small=1536, large=3072, ada-002=1536).

.PARAMETER Capacity
    Deployment capacity in thousands of tokens/min (TPM). Default: 120

.PARAMETER Sku
    Account SKU. Default: S0

.PARAMETER SkipBhgBrainConfig
    Provision only; do not touch config.json or environment variables.

.EXAMPLE
    ./Deploy-AzureFoundry.ps1 -AccountName bhgbrain-kevin-1 -Location eastus2

.EXAMPLE
    ./Deploy-AzureFoundry.ps1 -Model text-embedding-3-large -Dimensions 3072 -SkipBhgBrainConfig
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId,
    [string]$ResourceGroup = 'rg-bhgbrain',
    [string]$Location       = 'eastus',
    [string]$AccountName    = 'bhgbrain-foundry',
    [ValidateSet('OpenAI', 'AIServices')]
    [string]$Kind           = 'OpenAI',
    [string]$Model          = 'text-embedding-3-small',
    [string]$ModelVersion   = '1',
    [int]$Dimensions        = 0,
    [int]$Capacity          = 120,
    [string]$Sku            = 'S0',
    [switch]$SkipBhgBrainConfig
)

$ErrorActionPreference = 'Stop'

# --- helpers ---------------------------------------------------------------
function Invoke-Az {
    # Run az, throw on non-zero exit, return trimmed stdout.
    param([Parameter(Mandatory)][string[]]$Args, [switch]$AllowFail)
    $out = & az @Args 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFail) {
        throw "az $($Args -join ' ') failed:`n$out"
    }
    return ($out | Out-String).Trim()
}

function Write-Step { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }

# --- preflight -------------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI ('az') not found. Install it from https://aka.ms/installazurecli, then run 'az login'."
}

$AccountName = $AccountName.ToLowerInvariant()
if ($AccountName -notmatch '^[a-z0-9-]{2,64}$') {
    throw "AccountName '$AccountName' is invalid. Use 2-64 lowercase letters, numbers, or hyphens."
}

if ($Dimensions -le 0) {
    $Dimensions = switch ($Model) {
        'text-embedding-3-large' { 3072 }
        'text-embedding-3-small' { 1536 }
        'text-embedding-ada-002' { 1536 }
        default                  { 1536 }
    }
}

Write-Step "Checking az login"
$acct = Invoke-Az @('account', 'show', '-o', 'json') -AllowFail
if (-not $acct) { throw "Not logged in. Run 'az login' (or 'az login --use-device-code') and retry." }

if ($SubscriptionId) {
    Write-Step "Selecting subscription $SubscriptionId"
    Invoke-Az @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
}
$subName = Invoke-Az @('account', 'show', '--query', 'name', '-o', 'tsv')
$subId   = Invoke-Az @('account', 'show', '--query', 'id', '-o', 'tsv')
Write-Host "    Subscription: $subName ($subId)"

# --- provider registration -------------------------------------------------
Write-Step "Ensuring Microsoft.CognitiveServices provider is registered"
$state = Invoke-Az @('provider', 'show', '--namespace', 'Microsoft.CognitiveServices', '--query', 'registrationState', '-o', 'tsv') -AllowFail
if ($state -ne 'Registered') {
    Invoke-Az @('provider', 'register', '--namespace', 'Microsoft.CognitiveServices', '--wait') | Out-Null
}

# --- resource group --------------------------------------------------------
Write-Step "Resource group '$ResourceGroup' in $Location"
Invoke-Az @('group', 'create', '--name', $ResourceGroup, '--location', $Location, '-o', 'none') | Out-Null

# --- account ---------------------------------------------------------------
Write-Step "Cognitive Services account '$AccountName' (kind=$Kind, sku=$Sku)"
$exists = Invoke-Az @('cognitiveservices', 'account', 'show', '--name', $AccountName, '--resource-group', $ResourceGroup, '-o', 'json') -AllowFail
if (-not $exists) {
    Invoke-Az @(
        'cognitiveservices', 'account', 'create',
        '--name', $AccountName,
        '--resource-group', $ResourceGroup,
        '--location', $Location,
        '--kind', $Kind,
        '--sku', $Sku,
        '--custom-domain', $AccountName,
        '--yes', '-o', 'none'
    ) | Out-Null
    Write-Host "    Created."
} else {
    Write-Host "    Already exists - reusing."
}

# --- model deployment ------------------------------------------------------
# Deployment name MUST equal the model name for BHGBrain.
Write-Step "Deploying model '$Model' (version $ModelVersion, capacity ${Capacity}K TPM)"
$depExists = Invoke-Az @(
    'cognitiveservices', 'account', 'deployment', 'show',
    '--name', $AccountName, '--resource-group', $ResourceGroup,
    '--deployment-name', $Model, '-o', 'json'
) -AllowFail
if (-not $depExists) {
    Invoke-Az @(
        'cognitiveservices', 'account', 'deployment', 'create',
        '--name', $AccountName,
        '--resource-group', $ResourceGroup,
        '--deployment-name', $Model,
        '--model-name', $Model,
        '--model-version', $ModelVersion,
        '--model-format', 'OpenAI',
        '--sku-name', 'Standard',
        '--sku-capacity', "$Capacity",
        '-o', 'none'
    ) | Out-Null
    Write-Host "    Deployed."
} else {
    Write-Host "    Already exists - reusing."
}

# --- retrieve outputs ------------------------------------------------------
Write-Step "Retrieving endpoint and key"
$endpoint = Invoke-Az @('cognitiveservices', 'account', 'show', '--name', $AccountName, '--resource-group', $ResourceGroup, '--query', 'properties.endpoint', '-o', 'tsv')
$apiKey   = Invoke-Az @('cognitiveservices', 'account', 'keys', 'list', '--name', $AccountName, '--resource-group', $ResourceGroup, '--query', 'key1', '-o', 'tsv')
$openaiHost = "https://$AccountName.openai.azure.com"

Write-Host ""
Write-Host "Provisioning complete." -ForegroundColor Green
Write-Host "  resource_name (BHGBrain): $AccountName"
Write-Host "  OpenAI endpoint:          $openaiHost/openai/v1/embeddings"
Write-Host "  Account endpoint:         $endpoint"
Write-Host "  Model / deployment:       $Model"
Write-Host "  Dimensions:               $Dimensions"
Write-Host ""

# --- configure BHGBrain ----------------------------------------------------
if ($SkipBhgBrainConfig) {
    Write-Host "Skipping BHGBrain config (--SkipBhgBrainConfig)." -ForegroundColor Yellow
    Write-Host "To finish manually, set AZURE_FOUNDRY_API_KEY and run Set-BhgBrainAzureConfig.ps1:" -ForegroundColor Yellow
    Write-Host "  ./Set-BhgBrainAzureConfig.ps1 -ResourceName $AccountName -Model $Model -Dimensions $Dimensions -ApiKey <key>"
} else {
    $configScript = Join-Path $PSScriptRoot 'Set-BhgBrainAzureConfig.ps1'
    Write-Step "Configuring BHGBrain (config.json + AZURE_FOUNDRY_API_KEY)"
    & $configScript -ResourceName $AccountName -Model $Model -Dimensions $Dimensions -ApiKey $apiKey
}

# Return a structured object for scripted callers.
[PSCustomObject]@{
    ResourceName  = $AccountName
    ResourceGroup = $ResourceGroup
    Location      = $Location
    Kind          = $Kind
    Endpoint      = $openaiHost
    Model         = $Model
    Dimensions    = $Dimensions
    ApiKey        = $apiKey
}

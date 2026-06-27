#requires -Version 5.1
<#
.SYNOPSIS
    Tear down the Azure resources created by Deploy-AzureFoundry.ps1.

.DESCRIPTION
    Deletes the model deployment and the Cognitive Services account, and
    optionally the whole resource group. Cognitive Services accounts are
    soft-deleted by Azure; pass -Purge to permanently remove the account so its
    name/subdomain can be reused immediately.

.PARAMETER ResourceGroup
    Resource group containing the account. Default: rg-bhgbrain

.PARAMETER AccountName
    Account to delete. Default: bhgbrain-foundry

.PARAMETER Location
    Region (required for -Purge). Default: eastus

.PARAMETER DeleteResourceGroup
    Delete the entire resource group instead of just the account.

.PARAMETER Purge
    Permanently purge the soft-deleted account after deletion.

.EXAMPLE
    ./Remove-AzureFoundry.ps1 -AccountName bhgbrain-foundry -Purge

.EXAMPLE
    ./Remove-AzureFoundry.ps1 -DeleteResourceGroup
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$ResourceGroup = 'rg-bhgbrain',
    [string]$AccountName   = 'bhgbrain-foundry',
    [string]$Location      = 'eastus',
    [switch]$DeleteResourceGroup,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$AccountName = $AccountName.ToLowerInvariant()

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI ('az') not found. Install from https://aka.ms/installazurecli."
}

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$Args, [switch]$AllowFail)
    $out = & az @Args 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFail) { throw "az $($Args -join ' ') failed:`n$out" }
    return ($out | Out-String).Trim()
}

if ($DeleteResourceGroup) {
    if ($PSCmdlet.ShouldProcess($ResourceGroup, 'Delete resource group (all contained resources)')) {
        Write-Host "Deleting resource group '$ResourceGroup'..." -ForegroundColor Yellow
        Invoke-Az @('group', 'delete', '--name', $ResourceGroup, '--yes', '--no-wait') | Out-Null
        Write-Host "Deletion started (async)." -ForegroundColor Green
    }
} else {
    if ($PSCmdlet.ShouldProcess("$AccountName in $ResourceGroup", 'Delete Cognitive Services account')) {
        Write-Host "Deleting account '$AccountName'..." -ForegroundColor Yellow
        Invoke-Az @('cognitiveservices', 'account', 'delete', '--name', $AccountName, '--resource-group', $ResourceGroup) -AllowFail | Out-Null
        Write-Host "Deleted." -ForegroundColor Green
    }
}

if ($Purge -and -not $DeleteResourceGroup) {
    if ($PSCmdlet.ShouldProcess("$AccountName in $Location", 'Purge soft-deleted account')) {
        Write-Host "Purging soft-deleted account '$AccountName'..." -ForegroundColor Yellow
        Invoke-Az @('cognitiveservices', 'account', 'purge', '--name', $AccountName, '--resource-group', $ResourceGroup, '--location', $Location) -AllowFail | Out-Null
        Write-Host "Purged." -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Note: this does not revert BHGBrain config.json. To switch back to OpenAI," -ForegroundColor Cyan
Write-Host "restore the .bak file or set embedding.provider back to 'openai'." -ForegroundColor Cyan

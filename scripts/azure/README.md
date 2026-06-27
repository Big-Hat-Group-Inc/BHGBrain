# Azure AI Foundry setup for BHGBrain

These scripts provision an Azure AI Foundry / Azure OpenAI resource from scratch
and point BHGBrain at it via the `azure-foundry` embedding provider. You only
need an Azure subscription to start.

## What gets created

| Step | Resource |
| ---- | -------- |
| 1 | Resource group (default `rg-bhgbrain`) |
| 2 | Cognitive Services account (kind `OpenAI`) with a custom subdomain == the account name, exposing `https://<name>.openai.azure.com` |
| 3 | An embedding model deployment whose **deployment name equals the model name** |

> **Why deployment name == model name:** BHGBrain's Azure provider
> (`src/embedding/azure-foundry.ts`) calls
> `https://<resource_name>.openai.azure.com/openai/v1/embeddings` and sends the
> model name in the request body. Azure routes that to the deployment of the same
> name, so the two must match. The scripts enforce this for you.

## Prerequisites

- **Azure CLI** — install from <https://aka.ms/installazurecli>, then:
  ```powershell
  az login            # or: az login --use-device-code
  ```
- Run the scripts from PowerShell (5.1 or 7+).

## Quick start

```powershell
cd scripts/azure

# Provision + deploy + configure BHGBrain in one shot.
# AccountName must be GLOBALLY UNIQUE (it becomes <name>.openai.azure.com).
./Deploy-AzureFoundry.ps1 -AccountName bhgbrain-<something-unique> -Location eastus
```

This will:
1. Create the resource group, account, and `text-embedding-3-small` deployment.
2. Print the endpoint, resource name, and dimensions.
3. Set `embedding.provider = azure-foundry` (and model/dimensions/`azure.resource_name`)
   in your `config.json` at `%LOCALAPPDATA%\BHGBrain\config.json`.
4. Persist the key to the `AZURE_FOUNDRY_API_KEY` user environment variable.

Then restart BHGBrain. Verify embeddings work:

```powershell
bhgbrain health
```

## Common options

```powershell
# Larger model (3072 dims)
./Deploy-AzureFoundry.ps1 -AccountName bhgbrain-xyz -Model text-embedding-3-large -Dimensions 3072

# Provision only, don't touch BHGBrain config
./Deploy-AzureFoundry.ps1 -AccountName bhgbrain-xyz -SkipBhgBrainConfig

# Use the unified Azure AI Foundry (AIServices) resource kind instead of classic OpenAI
./Deploy-AzureFoundry.ps1 -AccountName bhgbrain-xyz -Kind AIServices

# A specific subscription / region / capacity (TPM in thousands)
./Deploy-AzureFoundry.ps1 -AccountName bhgbrain-xyz -SubscriptionId <guid> -Location eastus2 -Capacity 240
```

## Configure an existing deployment

If you already have an Azure account + deployment and only want to update BHGBrain:

```powershell
./Set-BhgBrainAzureConfig.ps1 -ResourceName <account-name> -Model text-embedding-3-small -Dimensions 1536 -ApiKey <key>
```

It backs up `config.json` to `config.json.bak` before editing.

## Tear down

```powershell
# Delete just the account (soft-delete) and purge so the name is reusable now
./Remove-AzureFoundry.ps1 -AccountName bhgbrain-xyz -Purge

# Or remove the whole resource group
./Remove-AzureFoundry.ps1 -DeleteResourceGroup
```

Teardown does **not** revert `config.json` — restore the `.bak` or set
`embedding.provider` back to `openai`.

## Dimension constraints (enforced by BHGBrain's Zod schema)

| Model | Max dimensions |
| ----- | -------------- |
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-ada-002` | 1536 (exactly) |

## Troubleshooting

- **`InvalidResourceName` / name taken** — the account name is a *global*
  subdomain. Pick a more unique `-AccountName`.
- **Model/capacity not available in region** — try `-Location eastus2`,
  `westus3`, or another region; or lower `-Capacity`. Check availability with
  `az cognitiveservices model list --location <region> -o table`.
- **`Missing environment variable: AZURE_FOUNDRY_API_KEY`** at BHGBrain startup —
  open a new terminal (the user env var isn't visible to already-running shells),
  or re-run with the key in the current session.
- **401/403 from the endpoint** — the account needs a custom subdomain for
  key auth; the scripts set `--custom-domain <name>` automatically. If you made
  the account by hand without one, recreate it.

# Read entire file
$filePath = '.\AzureFoundrySpec.md'
$content = Get-Content -Raw -Path $filePath

# Define new section
$newSection = @'
---
## 14. Best Practice Patterns for Azure Foundry Coding

This section consolidates key implementation patterns derived from the specification to ensure consistent, secure, and resilient Azure Foundry integrations.

### 14.1 Configuration & Validation

- **Fail-fast validation**: Invalid static configuration (missing resource name, invalid dimensions) should cause immediate startup failure, not runtime errors
- **Strict schema validation**: Use Zod-like validation with model-aware dimension checks (e.g., `ada-002` requires exactly 1536 dimensions)
- **Environment-based secrets**: Load API key once at construction from environment variables, never hardcode

### 14.2 Security & Credentials

- **Never log secrets**: API keys, headers, and full upstream error bodies must be redacted
- **Credential caching**: Cache keys in memory at startup; rotation requires restart/reload
- **Private endpoints**: For regulated deployments, prefer VNet/private networking over public internet exposure

### 14.3 API Integration Patterns

- **Standard endpoint construction**: Use `https://<resource>.openai.azure.com/openai/v1` as the canonical base URL
- **Deployment vs. model**: Treat `model` field as Azure deployment name, not underlying model family
- **Request chunking**: Automatically split batches exceeding Azure's per-request limits (max 2048 inputs)
- **Dimensions-aware requests**: Include `dimensions` field for v3 models, omit for legacy models like `ada-002`

### 14.4 Resilience & Error Handling

- **Circuit breaker pattern**: Use provider-aware breaker keys (`azure_foundry_embedding`)
- **Retry strategy**: Retry only transient failures (network errors, 429, 5xx) with exponential backoff
- **Timeout control**: Use `AbortController` with configurable timeout (default 30s)
- **Error mapping**: Map Azure-specific HTTP errors to consistent internal error types, sanitize messages
- **Degraded mode**: Degrade only for missing startup credentials; runtime failures surface as errors

### 14.5 Observability & Health

- **Real health checks**: Perform authenticated embedding calls, cache results (30s), bypass circuit breaker for probes
- **Metrics**: Record latency histograms (`embedding_embed_batch_ms`) for batch operations
- **Provider-aware monitoring**: Health endpoints report provider-specific breaker keys

### 14.6 Migration & Compatibility

- **No cross‑provider assumptions**: Vectors are not guaranteed identical; validate retrieval quality before cutover
- **Clear compatibility rules**: Same model family + dimensions may allow collection reuse; otherwise reindex
- **Canary migration**: Test with isolated namespace/collection before production switch

### 14.7 Testing & Documentation

- **Comprehensive unit tests**: Cover base‑URL construction, auth headers, batch chunking, error mapping, retry logic
- **Integration tests**: Use real Azure deployments to verify end‑to‑end flows
- **Operator guidance**: Document secret rotation, private endpoints, migration procedures, and rollback steps

---
## 15. Files Changed
'@

# Perform replacement - escape regex special characters
$pattern = [regex]::Escape('Provider-specific metrics are optional, but the existing `embedding_embed_batch_ms` metric must continue to work.')
$pattern += '\r?\n\r?\n---\r?\n\r?\n## 14\. Files Changed'
$content = [regex]::Replace($content, $pattern, $newSection)

# Update subsequent section numbers: 15 -> 16, 16 -> 17
$content = $content -replace '## 15\. Out of Scope', '## 16. Out of Scope'
$content = $content -replace '## 16\. References', '## 17. References'

# Write back
Set-Content -Path $filePath -Value $content -Encoding UTF8
Write-Output 'File updated successfully'
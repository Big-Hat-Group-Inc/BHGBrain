## ADDED Requirements

### Requirement: Azure Foundry embedding provider configuration is validated at startup
The system SHALL support `embedding.provider = "azure-foundry"` and SHALL require a valid Azure embedding configuration before startup succeeds. Azure configuration MUST include a DNS-safe `embedding.azure.resource_name`, a configured Azure API key environment variable name, a supported embedding model, compatible dimensions, and `max_batch_inputs` no greater than `2048`.

#### Scenario: Valid Azure configuration selects the Azure provider
- **WHEN** `embedding.provider` is `"azure-foundry"` and the configured resource name, model, dimensions, batch size, and Azure API key environment variable are valid
- **THEN** the system constructs the Azure embedding provider using `https://<resource>.openai.azure.com/openai/v1`

#### Scenario: Invalid Azure static configuration fails startup
- **WHEN** `embedding.provider` is `"azure-foundry"` and required Azure config is missing, the resource name is invalid, the model and dimensions are incompatible, or `max_batch_inputs` exceeds `2048`
- **THEN** the system rejects startup configuration instead of silently degrading

### Requirement: Azure embedding requests use Azure-compatible authentication and payload rules
When the active provider is `azure-foundry`, the system SHALL send embedding requests to the Azure OpenAI-compatible embeddings endpoint using the `api-key` header, the configured deployment name in the `model` field, and batch-array `input` values. The system SHALL include `dimensions` for `text-embedding-3-small` and `text-embedding-3-large`, and SHALL omit `dimensions` for `text-embedding-ada-002`.

#### Scenario: V3 Azure model request includes dimensions
- **WHEN** the active provider is `azure-foundry` and the configured model is `text-embedding-3-small` or `text-embedding-3-large`
- **THEN** the outbound embeddings request includes `model`, array `input`, and the configured `dimensions` value

#### Scenario: Ada-002 Azure request omits dimensions
- **WHEN** the active provider is `azure-foundry` and the configured model is `text-embedding-ada-002`
- **THEN** the outbound embeddings request includes `model` and array `input`
- **AND** it does not send a `dimensions` field

### Requirement: Azure batch execution preserves ordering and handles transient failures
The Azure embedding provider SHALL split batch requests into chunks of at most `max_batch_inputs`, preserve result ordering across chunks, apply request timeouts, and retry only plausibly transient failures using exponential backoff. Retryable failures MUST include network failures, timeouts, HTTP `429`, and HTTP `5xx`; non-retryable client errors MUST surface without retry.

#### Scenario: Oversized batch is chunked and reassembled in order
- **WHEN** the caller submits more inputs than the configured `max_batch_inputs`
- **THEN** the system sends multiple Azure embeddings requests
- **AND** it returns embeddings in the same logical order as the original input list

#### Scenario: Retryable Azure failure is retried before surfacing
- **WHEN** an Azure embeddings request fails with a network error, timeout, HTTP `429`, or HTTP `5xx`
- **THEN** the system retries the request according to the configured backoff and attempt limits
- **AND** it does not retry HTTP `400`, `401`, `403`, or `404` failures

### Requirement: Azure startup degradation and runtime failure boundaries remain explicit
When `azure-foundry` is selected, the system SHALL degrade only for missing startup credentials, SHALL fail fast for invalid static configuration, and SHALL treat runtime Azure failures as provider request failures rather than replacing the provider instance after startup.

#### Scenario: Missing Azure API key degrades startup
- **WHEN** `embedding.provider` is `"azure-foundry"` and the configured Azure API key environment variable is absent during provider construction
- **THEN** the system uses the degraded embedding provider instead of a live Azure provider

#### Scenario: Runtime Azure outage does not replace the active provider
- **WHEN** Azure requests fail after startup because of service unavailability, timeouts, or network disruption
- **THEN** the system surfaces provider failures through normal error handling and circuit-breaker behavior
- **AND** it does not swap the configured provider instance for a degraded provider

### Requirement: Azure provider selection does not change the MCP contract
Selecting `azure-foundry` as the embedding provider SHALL NOT add or remove MCP tools, resources, request arguments, or response-envelope shapes compared with `openai`.

#### Scenario: Provider switch leaves MCP surfaces unchanged
- **WHEN** an operator switches between `openai` and `azure-foundry`
- **THEN** `remember`, `recall`, search-related tools, resources, and embedding-related error envelope shapes remain unchanged

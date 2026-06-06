## ADDED Requirements

### Requirement: Configured embedding model is validated against a supported set at startup
The system SHALL validate `embedding.model` against a canonical set of supported embedding models during configuration validation, for both `embedding.provider = "openai"` and `embedding.provider = "azure-foundry"`. An unsupported or unknown model MUST cause configuration validation to fail at startup (fail-fast) rather than degrade or silently proceed, and the validation error MUST clearly identify the configured model and list the supported models.

#### Scenario: Unsupported model is rejected at startup
- **WHEN** `embedding.model` is set to a value that is not in the supported model set
- **AND** `embedding.provider` is `"openai"` or `"azure-foundry"`
- **THEN** configuration validation fails at startup
- **AND** the error names the unsupported model and lists the supported models
- **AND** the system does not start with that configuration

#### Scenario: Supported model is accepted
- **WHEN** `embedding.model` is one of the supported models with compatible `dimensions`
- **THEN** configuration validation succeeds
- **AND** the active embedding provider is constructed with that model

### Requirement: Effective embedding dimensions are resolved for a validated model
For a validated supported model, the system SHALL resolve an effective `embedding.dimensions` value that satisfies the model's dimension constraints, and SHALL NOT silently omit or leave the dimensions unresolved. The on-the-wire `dimensions` field MAY still be omitted for models that do not accept it (for example `text-embedding-ada-002`), but only after the model has been validated as supported.

#### Scenario: Dimensions resolved within the model's cap
- **WHEN** a supported model is configured with `dimensions` within that model's allowed range
- **THEN** the resolved effective dimensions match the configured value
- **AND** the provider uses those dimensions consistently with the Qdrant collection

#### Scenario: Incompatible dimensions for a supported model are rejected
- **WHEN** a supported model is configured with `dimensions` outside that model's allowed range
- **THEN** configuration validation fails at startup with a dimension-compatibility error

#### Scenario: Unsupported model cannot silently omit dimensions
- **WHEN** `embedding.model` is not a supported model
- **THEN** configuration validation fails before any provider is constructed
- **AND** the system never sends an embedding request that silently omits resolved dimensions for an unvalidated model

### Requirement: Embedding health probes are single-shot and bounded
The embedding health probe SHALL issue a single bounded request (respecting the configured request timeout) and SHALL NOT run the production retry/backoff loop. The probe SHALL bypass the circuit breaker and SHALL report its result as a boolean, returning `false` on failure without throwing to the health caller. This behavior MUST be consistent across the `openai` and `azure-foundry` providers.

#### Scenario: Azure health probe does not retry
- **WHEN** the active provider is `azure-foundry` and a health probe is performed against an unavailable endpoint
- **THEN** the probe issues a single request without exponential-backoff retries
- **AND** it returns `false` quickly without throwing

#### Scenario: Health probe bypasses the breaker and returns a boolean
- **WHEN** the system performs an embedding health probe for the active provider
- **THEN** the probe issues a direct authenticated request that does not use the circuit breaker
- **AND** the result is reported as a boolean health value

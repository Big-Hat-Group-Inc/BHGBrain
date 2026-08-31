## ADDED Requirements

### Requirement: Embedding breaker reporting uses the active provider key
The system SHALL report the embedding circuit breaker using a provider-aware key that matches the active embedding provider. The key MUST be `openai_embedding` when the active provider is `openai` and `azure_foundry_embedding` when the active provider is `azure-foundry`.

#### Scenario: OpenAI breaker key is reported for the OpenAI provider
- **WHEN** the active embedding provider is `openai`
- **THEN** health reporting uses `openai_embedding` as the embedding breaker key

#### Scenario: Azure breaker key is reported for the Azure provider
- **WHEN** the active embedding provider is `azure-foundry`
- **THEN** health reporting uses `azure_foundry_embedding` as the embedding breaker key

### Requirement: Embedding health probes use real authenticated provider checks
The system SHALL perform embedding health probes by issuing a real authenticated embedding request against the active provider, SHALL bypass the circuit breaker for those probes, and SHALL report probe success as a boolean health result.

#### Scenario: Invalid Azure credentials produce an unhealthy probe result
- **WHEN** the active embedding provider is `azure-foundry` and the configured credentials are invalid
- **THEN** the embedding health probe returns `false`
- **AND** it does not throw a provider-specific exception to the health caller

#### Scenario: Health probes bypass the embedding breaker
- **WHEN** the system performs an embedding health check for the active provider
- **THEN** the probe issues a direct authenticated provider request
- **AND** it does not use the embedding circuit breaker for the probe

### Requirement: Provider-aware health reporting preserves the existing health surface
Changing the active embedding provider SHALL preserve the existing HTTP and CLI health payload shape while updating only the embedding breaker key and provider-specific status content. The system SHALL continue to cache embedding health results according to the existing health-service cache window.

#### Scenario: Provider change preserves health payload shape
- **WHEN** an operator switches the active embedding provider from `openai` to `azure-foundry`
- **THEN** the HTTP and CLI health surfaces keep the same response structure
- **AND** only the embedding breaker key value and provider-specific health result change

#### Scenario: Repeated health reads reuse the cached embedding result
- **WHEN** multiple health reads occur within the configured embedding health cache window
- **THEN** the system reuses the cached embedding health result instead of probing the provider on every read

## Purpose

Defines one reliable request policy for embedding and chat-based AI features so endpoints, credentials, deadlines, retries, errors, breakers, and telemetry behave consistently.

## ADDED Requirements

### Requirement: AI provider configuration SHALL resolve consistently
All OpenAI-compatible features SHALL derive their base URL and credential through shared validated configuration, including the documented fallback from feature-specific secret names to `OPENAI_API_KEY`.

#### Scenario: Only the common API key is set
- **WHEN** an operator enables summarization or contradiction detection with only `OPENAI_API_KEY`
- **THEN** the feature initializes with that credential or reports one explicit configuration error

#### Scenario: Compatible gateway is configured
- **WHEN** a validated OpenAI-compatible base URL is supplied
- **THEN** every migrated chat and embedding feature addresses that gateway consistently

### Requirement: Request deadlines SHALL cover complete response consumption
Configured deadlines SHALL remain active through header receipt, body reading, parsing, and response validation.

#### Scenario: Provider stalls after sending headers
- **WHEN** a provider returns successful headers but stops during the body
- **THEN** the request aborts at the configured deadline
- **AND** the breaker records a failure rather than a success

### Requirement: HTTP failures SHALL be classified inside breaker execution
Rate limits, retryable server errors, permanent client errors, aborts, and network failures SHALL retain distinct retryability and SHALL update breaker state before control returns to the feature.

#### Scenario: Provider repeatedly returns 503
- **WHEN** a feature receives enough 503 responses to reach its breaker threshold
- **THEN** the breaker opens and subsequent calls fail fast

#### Scenario: Provider returns 401
- **WHEN** authentication is rejected
- **THEN** the returned error is non-retryable and retains the provider status context

### Requirement: Retries SHALL honor provider guidance and avoid synchronization
Retryable requests SHALL honor valid `Retry-After`, use capped jittered backoff, and expose the final retry guidance to callers.

#### Scenario: Provider returns Retry-After
- **WHEN** a 429 or 503 response includes a valid delay
- **THEN** the next attempt waits at least that delay subject to the configured cap

### Requirement: Every enabled AI feature SHALL be observable
Entailment, extraction, reranking, summarization, query expansion, distillation, and embedding SHALL expose breaker state plus success, degraded, timeout, and classified-failure metrics.

#### Scenario: Entailment provider is unavailable
- **WHEN** contradiction detection degrades or fails open
- **THEN** logs and metrics identify entailment as the failed feature and preserve the cause

### Requirement: Provider responses SHALL be validated before use
Embedding responses SHALL match requested input count and configured vector dimensions, and chat responses SHALL pass feature-specific schema validation before affecting memory state.

#### Scenario: Embedding gateway returns a short result array
- **WHEN** fewer embeddings are returned than inputs supplied
- **THEN** the batch fails as an invalid provider response without associating vectors with the wrong memories

### Requirement: Batch limits SHALL apply to provider requests
Every embedding path SHALL honor the configured maximum inputs per request while preserving result order.

#### Scenario: Input exceeds the provider batch cap
- **WHEN** a caller embeds more items than `max_batch_inputs`
- **THEN** requests are split into bounded batches and results are reassembled in input order

## ADDED Requirements

### Requirement: Read paths MUST NOT synchronously flush full database state
Read-only operations SHALL NOT trigger full-database export and synchronous disk writes on the request path.

#### Scenario: Search read updates access metadata
- **WHEN** a search request updates `last_accessed` or `access_count`
- **THEN** the request does not perform full database export/write before returning

### Requirement: Access-metadata persistence is batched or deferred
Access metadata updates SHALL be persisted using bounded asynchronous batching or equivalent non-blocking mechanism.

#### Scenario: High-volume read workload
- **WHEN** many read operations occur in short intervals
- **THEN** write amplification is bounded and request latency is not proportional to full database size

## 1. Domain Model and Validation

- [x] 1.1 Define TypeScript domain types for canonical memory records, memory types, and category slots.
- [x] 1.2 Implement input normalization and validation for schema constraints (lengths, ranges, enums, defaults).
- [x] 1.3 Add unit tests covering valid and invalid canonical memory payloads.

## 2. Namespace-Scoped Storage Layer

- [x] 2.1 Implement SQLite schema and repositories for memory metadata, tags, and category revision tracking.
- [x] 2.2 Implement Qdrant collection management and vector upsert/read helpers with namespace and collection metadata.
- [x] 2.3 Add consistency checks that ensure successful writes only when both stores commit required records.

## 3. Write Decision Pipeline

- [x] 3.1 Implement extraction stage that emits atomic candidates when extraction is enabled.
- [x] 3.2 Implement candidate decisioning logic for ADD, UPDATE, DELETE, and NOOP using namespace-scoped similarity retrieval.
- [x] 3.3 Implement deterministic fallback mode with checksum and similarity-threshold behavior.
- [x] 3.4 Add integration tests validating ADD/UPDATE/DELETE/NOOP outcomes and deterministic fallback parity.

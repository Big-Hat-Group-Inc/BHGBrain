## ADDED Requirements

### Requirement: A missing Qdrant collection is recognized from the real client's error shape
The Qdrant adapter SHALL treat a `404` response whose Qdrant error body (`data.status.error`) or message names a missing collection or point as "not found", regardless of whether that text appears in the thrown error's `message`.

#### Scenario: First write to a new namespace
- **WHEN** a client calls `remember` with a namespace whose Qdrant collection does not exist yet (with or without `/`)
- **THEN** the dedup lookup reports no near-duplicates, the memory is stored, and the Qdrant collection is created

#### Scenario: First write to a new collection in the default namespace
- **WHEN** a client calls `remember` with `collection: "diagnostic"` in `global` and no such Qdrant collection exists
- **THEN** the memory is stored with operation `ADD`

#### Scenario: Write to a collection created with `collections create`
- **WHEN** a collection row exists in SQLite (from `collections create`) but its Qdrant collection does not
- **THEN** `remember` into it succeeds

#### Scenario: Bootstrap stores answers in `profile`
- **WHEN** `bootstrap submit` is called for section 1 on a fresh `profile` namespace
- **THEN** the answers are stored and `bootstrap status` reports section 1 complete

#### Scenario: Health with no default collection yet
- **WHEN** the health probe queries a default collection that does not exist yet
- **THEN** the Qdrant component reports healthy

### Requirement: A non-Qdrant 404 remains a failure
A `404` whose body does not name a missing Qdrant collection or point SHALL NOT be treated as "not found".

#### Scenario: Reverse proxy 404 page
- **WHEN** every request returns an HTML `404 page not found` body
- **THEN** the similarity lookup and the health probe both fail rather than reporting "empty"

### Requirement: Permanent upstream rejections are not retryable
An unclassified error reaching the tool boundary with an HTTP status in 400–499 other than `408` or `429` SHALL be returned as `INTERNAL` with `retryable: false`, and its message SHALL name the status without echoing the upstream response body.

#### Scenario: Upstream 400
- **WHEN** a tool call fails because Qdrant rejected the request with `400`
- **THEN** the envelope is `{ code: "INTERNAL", retryable: false }` with a message naming HTTP 400 and no upstream body text

#### Scenario: Transient upstream status
- **WHEN** the upstream status is `408`, `429`, or a 5xx
- **THEN** the envelope keeps the generic `retryable: true` fallback

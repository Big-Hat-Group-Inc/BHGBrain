## ADDED Requirements

### Requirement: Omitted-collection retrieval searches the full namespace
When a client omits `collection`, the system SHALL evaluate semantic, fulltext, and hybrid retrieval across all collections in the requested namespace instead of narrowing to `general`.

#### Scenario: Semantic search without a collection includes non-general collections
- **WHEN** a namespace contains relevant memories in `general` and in another collection and a client performs semantic search without supplying `collection`
- **THEN** the retrieval path searches all collections in that namespace
- **AND** eligible results from non-`general` collections remain available for ranking and hydration

#### Scenario: Hybrid search uses the same scope for vector and fulltext inputs
- **WHEN** a client performs hybrid search without supplying `collection`
- **THEN** the semantic candidate set and the fulltext candidate set are both gathered from the same namespace-wide collection scope
- **AND** the final ranking does not silently exclude non-`general` collections

### Requirement: Exact deduplication respects collection boundaries
Exact checksum deduplication SHALL be scoped to the target namespace and target collection so identical content in different collections does not collapse into one write decision.

#### Scenario: Same checksum in a different collection remains addable
- **WHEN** a memory with checksum `X` already exists in namespace `N` and collection `A`
- **AND** a client stores the same normalized content in namespace `N` and collection `B`
- **THEN** exact deduplication does not return a terminal match from collection `A`
- **AND** the pipeline may continue with add-or-update behavior within collection `B`

#### Scenario: Same checksum in the same collection remains a no-op
- **WHEN** a memory with checksum `X` already exists in namespace `N` and collection `A`
- **AND** a client stores the same normalized content again in namespace `N` and collection `A`
- **THEN** the write decision returns a terminal exact-dedup no-op for that existing memory

### Requirement: Collection resources return complete collection-scoped results
Collection resources SHALL query collection membership directly and SHALL support pagination so results are not truncated by unrelated namespace activity.

#### Scenario: Collection resource does not truncate before filtering
- **WHEN** a namespace contains more recent memories in other collections than in the requested collection
- **AND** a client reads `collection://{name}`
- **THEN** the resource query selects rows for the requested collection directly
- **AND** older matching memories in that collection remain retrievable

#### Scenario: Collection resource paginates large collections
- **WHEN** a requested collection contains more results than a single page can return
- **THEN** the resource response returns a deterministic page of collection-scoped results
- **AND** the response includes the cursor or pagination contract needed to request the next page

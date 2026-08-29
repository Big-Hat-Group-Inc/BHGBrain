## ADDED Requirements

### Requirement: Writes SHALL be automatically tagged from deterministic content signal
When `pipeline.auto_tag_enabled` is true, the write pipeline SHALL derive additional
tags from the normalized content of every candidate — code-shaped identifiers
(including markdown inline-code spans), file paths, repo shorthand (`owner/repo`),
and `@mentions` — and merge them with any caller-supplied tags.

#### Scenario: Untagged content with a file path and an identifier gains tags
- **WHEN** a memory is written with no caller-supplied tags and content containing a
  file path (e.g. `src/pipeline/index.ts`) and a camelCase identifier (e.g.
  `extractionEnabled`)
- **THEN** the stored memory's `tags` array SHALL include a slugified tag derived
  from the file path and a slugified tag derived from the identifier

#### Scenario: Caller-supplied tags are preserved alongside auto-derived tags
- **WHEN** a memory is written with caller-supplied tags and content that also
  matches an auto-tag pattern
- **THEN** the stored memory's `tags` array SHALL contain the union of the
  caller-supplied tags and the auto-derived tags

#### Scenario: @-mention is extracted and distinguished from an email address
- **WHEN** content contains an `@handle`-shaped token not immediately preceded by a
  word character (e.g. "cc @jsmith on this")
- **THEN** the stored memory's `tags` array SHALL include a tag derived from the
  mention
- **WHEN** content contains an email address (e.g. `jsmith@example.com`)
- **THEN** no mention tag SHALL be derived from the email's local or domain part

#### Scenario: Repo shorthand is distinguished from a file path
- **WHEN** content contains a two-segment slash token with no recognized file
  extension on the trailing segment (e.g. `bhgbrain/core`)
- **THEN** the stored memory's `tags` array SHALL include a tag derived from the repo
  shorthand
- **WHEN** content contains a slash-separated token whose trailing segment has a
  recognized file extension (e.g. `src/pipeline/index.ts`)
- **THEN** the derived tag SHALL be classified as a file path, not repo shorthand

### Requirement: Auto-derived tags SHALL satisfy the existing tag validation pattern
Every tag the extractor emits SHALL already conform to `TagSchema`
(`^[a-zA-Z0-9-]+$`, max 100 characters) without requiring any change to tag
validation.

#### Scenario: Extracted tokens are slugified to fit the existing pattern
- **WHEN** an auto-tag candidate contains characters outside `[a-zA-Z0-9-]` (e.g. a
  path separator, a dot, an `@`, or an underscore)
- **THEN** the extractor SHALL normalize the candidate (lowercase; `@` mapped to an
  `at-` prefix; other disallowed characters collapsed to `-`; leading/trailing `-`
  trimmed; truncated to 100 characters) before it is added to the memory's tags
- **AND** the normalized tag SHALL pass `TagSchema` validation unchanged

#### Scenario: Degenerate matches are dropped
- **WHEN** slugifying a candidate yields fewer than 2 characters
- **THEN** that candidate SHALL be discarded and not added to the memory's tags

### Requirement: Auto-tagging SHALL respect the existing per-memory tag cap and never evict caller-supplied tags
The merged tag array (caller-supplied ∪ auto-derived) SHALL never exceed the existing
20-tag limit, and trimming to that limit SHALL prefer caller-supplied tags over
auto-derived ones.

#### Scenario: Combined tags exceed the cap
- **WHEN** the union of caller-supplied and auto-derived tags exceeds 20 entries
- **THEN** the stored `tags` array SHALL be trimmed to 20 entries
- **AND** every caller-supplied tag SHALL be retained in the trimmed array
- **AND** the entries dropped to make room SHALL be auto-derived tags

#### Scenario: Auto-tag extraction is capped per memory
- **WHEN** content matches more auto-tag candidates than
  `pipeline.auto_tag_max_per_memory`
- **THEN** only up to `pipeline.auto_tag_max_per_memory` auto-derived tags SHALL be
  added, prioritized by extraction category order (code-shaped tokens, file paths,
  repo shorthand, then @-mentions) and first-seen order within a category

### Requirement: Auto-tagging SHALL be configurable and disableable
`pipeline.auto_tag_enabled` and `pipeline.auto_tag_max_per_memory` SHALL be validated
configuration fields, and disabling auto-tagging SHALL restore exact pre-feature
behavior.

#### Scenario: Operator disables auto-tagging
- **WHEN** `pipeline.auto_tag_enabled` is `false`
- **THEN** the write pipeline's candidate tags SHALL be exactly the caller-supplied
  `tags` input, with no auto-derived tags added

### Requirement: Auto-tagging SHALL NOT influence write classification
Auto-derived tags SHALL be computed from content but SHALL NOT change whether a write
is classified as ADD, UPDATE, DELETE, or NOOP.

#### Scenario: Classification is unaffected by auto-tagging
- **WHEN** a write's checksum and embedding are computed from its content
- **THEN** the write's ADD/UPDATE/DELETE/NOOP classification SHALL be identical
  whether `pipeline.auto_tag_enabled` is `true` or `false`

### Requirement: Auto-derived tags SHALL be usable by existing tag filtering and fulltext scoring without modification
Auto-derived tags SHALL be stored as ordinary entries in a memory's `tags` array,
requiring no changes to the `recall`/`search` `tags` filter or to fulltext tag
weighting.

#### Scenario: Recall filters on an auto-derived tag
- **WHEN** a memory was written with no caller-supplied tags but content that
  produced an auto-derived tag
- **AND** a subsequent `recall` or `search` call filters by that tag
- **THEN** the memory SHALL be included in the filtered results

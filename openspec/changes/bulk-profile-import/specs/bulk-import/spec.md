## ADDED Requirements

### Requirement: Import tool accepts profile format
The system SHALL expose a `bhgbrain.import` MCP tool that accepts a `format` parameter of `"profile"` or `"freeform"`, a `content` string, an optional `namespace` (default `"profile"`), and an optional `dry_run` boolean (default `false`).

#### Scenario: Valid profile import
- **WHEN** the tool is called with `format: "profile"` and `content` containing a 12-section bootstrap profile document
- **THEN** the system SHALL parse the document into discrete memories, one or more per section, with collection, tier, type, importance, and tags assigned per the section mapping table

#### Scenario: Valid freeform import
- **WHEN** the tool is called with `format: "freeform"` and `content` containing arbitrary markdown text
- **THEN** the system SHALL split the text by headings and paragraph boundaries into discrete chunks, each stored as a memory with `type: "semantic"`, `tier: "T2"`, and the specified namespace

#### Scenario: Missing content
- **WHEN** the tool is called with an empty or missing `content` parameter
- **THEN** the system SHALL return an error with code `INVALID_INPUT`

### Requirement: Profile section parsing
The system SHALL recognize the 12-section bootstrap format by detecting `## N.` heading patterns (e.g., `## 1. Core Identity`) and SHALL map each section to its designated collection, retention tier, memory type, importance range, and tags.

#### Scenario: All 12 sections present
- **WHEN** a profile document contains all 12 numbered sections
- **THEN** each section SHALL be parsed and mapped to the correct metadata per the section mapping table, producing one or more memories per section

#### Scenario: Partial profile
- **WHEN** a profile document contains fewer than 12 sections
- **THEN** the system SHALL parse and import only the sections present, without error, and the summary SHALL indicate which sections were processed

### Requirement: Dry run mode
The system SHALL support a `dry_run` parameter that, when `true`, returns a preview of all memories that would be created without writing any data to storage.

#### Scenario: Dry run returns preview
- **WHEN** the tool is called with `dry_run: true`
- **THEN** the system SHALL return a list of memory previews (content snippet, collection, tier, type, tags) and a summary count, with zero writes to SQLite or Qdrant

### Requirement: Deduplication on import
The system SHALL apply the existing checksum-based deduplication during import. Memories whose content checksum matches an existing record in the same namespace and collection SHALL be skipped.

#### Scenario: Duplicate content skipped
- **WHEN** a memory being imported has the same checksum as an existing record in the target namespace and collection
- **THEN** the system SHALL skip that memory and increment the `duplicates_skipped` counter in the summary

### Requirement: Import summary response
The system SHALL return a structured summary after import completion containing: total memories created, total duplicates skipped, collections touched, and sections processed (for profile format).

#### Scenario: Successful import summary
- **WHEN** an import operation completes (dry_run: false)
- **THEN** the response SHALL include `memories_created` (number), `duplicates_skipped` (number), `collections` (string array), and `sections_processed` (number, profile format only)

## 1. Section Parser

- [x] 1.1 Create `src/pipeline/parser.ts` with `ProfileParser` class and section mapping table (12 sections → collection, tier, type, importance, tags)
- [x] 1.2 Implement `parseProfile(content: string)` that splits by `## N.` headings and returns parsed memory candidates with metadata
- [x] 1.3 Implement `parseFreeform(content: string)` that splits by headings and paragraph boundaries, returning chunks with default metadata
- [x] 1.4 Add unit tests for `ProfileParser` covering all 12 sections, partial profiles, and freeform input

## 2. Import Tool Handler

- [x] 2.1 Create `src/tools/import.ts` with input validation (format, content, namespace, dry_run params) and `INVALID_INPUT` error for empty content
- [x] 2.2 Implement dry-run path that parses input and returns memory previews without writing
- [x] 2.3 Implement write path that iterates parsed candidates through `WritePipeline.process()`, collecting results and tracking duplicates
- [x] 2.4 Build structured summary response (memories_created, duplicates_skipped, collections, sections_processed)

## 3. MCP Tool Registration

- [x] 3.1 Register `bhgbrain.import` tool in `src/index.ts` with JSON schema for params (format, content, namespace, dry_run)
- [x] 3.2 Wire tool handler to the import module

## 4. Integration Tests

- [x] 4.1 Add integration test: full 12-section profile import with dedup verification
- [x] 4.2 Add integration test: freeform document import
- [x] 4.3 Add integration test: dry-run returns preview with zero writes

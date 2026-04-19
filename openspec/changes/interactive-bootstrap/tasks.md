## 1. Shared Section Definitions

- [x] 1.1 Create `src/bootstrap/sections.ts` with the 12-section definition array (title, questions, collection, tier, type, importance, tags)
- [x] 1.2 Add unit tests verifying all 12 sections have valid metadata mappings
- [x] 1.3 Refactor `ProfileParser` (from bulk-profile-import) to import section mappings from this shared module

## 2. Session State Storage

- [x] 2.1 Add `bootstrap_sessions` table to SQLite schema (namespace, section_number, status, memory_ids JSON, updated_at)
- [x] 2.2 Create `src/bootstrap/session.ts` with CRUD operations: createSession, getSession, updateSection, resetSection
- [x] 2.3 Add unit tests for session state CRUD (create, resume, update, reset)

## 3. Bootstrap Tool Handler

- [x] 3.1 Create `src/tools/bootstrap.ts` with action routing (start, submit, status, reset) and input validation
- [x] 3.2 Implement `start` action: create or resume session, return first incomplete section
- [x] 3.3 Implement `submit` action: parse answers into memories, store via WritePipeline, update session state, return next section
- [x] 3.4 Implement `status` action: return session progress overview
- [x] 3.5 Implement `reset` action: delete tracked memories, mark section as pending

## 4. MCP Tool Registration

- [x] 4.1 Register `bhgbrain.bootstrap` tool in `src/index.ts` with JSON schema for params (action, section, answers, namespace)

## 5. Integration Tests

- [x] 5.1 Add integration test: full start → submit all 12 sections → completion flow
- [x] 5.2 Add integration test: resume session after simulated restart
- [x] 5.3 Add integration test: reset section deletes memories and allows re-submission

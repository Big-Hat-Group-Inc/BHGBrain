## 1. Type and Coverage Gates

- [ ] 1.1 Add a test-aware TypeScript configuration and include it in the standard lint workflow; verify an intentionally invalid mock type fails the command before removing the fixture.
- [ ] 1.2 Enable type-aware floating-promise and misused-promise ESLint rules, fix the resulting production/test backlog without broad disables, and verify `npm run lint` passes.
- [ ] 1.3 Add a coverage script, measure the current V8 baseline, and commit rounded ratcheting thresholds; verify a controlled threshold increase makes the coverage command fail before restoring it.

## 2. Seam Integration Coverage

- [ ] 2.1 Add real-SQLite retention integration tests covering lifecycle ownership, expired archival/deletion, pruning, and last-success state and verify they fail against the pre-fix self-rejecting GC.
- [ ] 2.2 Add MCP session manager tests for create, lookup, unknown ID, delete, close-all, idle expiry, and capacity and verify every server/transport is closed exactly once.
- [ ] 2.3 Add successful forget and backup tool-dispatch tests with representative vector/provider doubles and verify classified partial failures retain their envelopes.
- [ ] 2.4 Add bidirectional parity tests across dispatch cases, schemas, MCP declarations, and REST allowlists and verify a temporary missing registration fails the suite.

## 3. Shared Boundaries and Handler Extraction

- [ ] 3.1 Extract and test one schema-narrowing vector-payload-to-memory mapper covering every lifecycle, expiry, review, checksum, embedding, and provenance field.
- [ ] 3.2 Migrate hydration, repair, and search fallback to the canonical mapper and verify shared round-trip fixtures pass for all consumers.
- [ ] 3.3 Split review and repair into per-action handlers without changing public schemas and verify existing plus focused action tests pass.
- [ ] 3.4 Extract recall pool sizing and hybrid rank fusion into pure helpers and verify boundary, tie, and empty-input tests without transport setup.
- [ ] 3.5 Run `npm run lint`, `npm test`, the new coverage command, `npm run eval`, and `npm run build`, recording the final thresholds and any approved eval deltas.

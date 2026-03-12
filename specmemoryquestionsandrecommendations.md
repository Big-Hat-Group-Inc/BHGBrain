# Memory Management - Questions and Recommendations

> Open questions and engineering recommendations for the BHGBrain tiered memory management subsystem.

---

## Questions

### Tier Classification

**Q1. Should the LLM classifier be required for tier assignment, or is heuristic-only acceptable for v1?**
The heuristic classifier handles obvious cases (ticket patterns, architecture keywords) but may misclassify ambiguous content. The LLM classifier adds cost per write (~$0.001/call with gpt-4o-mini). Options:
- Heuristic only for v1, add LLM classification in v2
- LLM classification always, accept the cost
- LLM classification only when heuristic confidence is below a threshold (e.g., < 0.6)

**Recommendation:** Use heuristic-first with LLM fallback when confidence < 0.6. This keeps cost low for obvious cases (tickets are clearly T3, architecture docs are clearly T0) while improving accuracy on the ambiguous middle ground. The extraction pipeline already calls the LLM, so piggyback tier classification onto the same call.

---

**Q2. What happens when a memory doesn't match any heuristic signal?**
The current default is T2 (operational, 90-day TTL). Is this the right default? Alternatives:
- Default T2 (moderate retention, most forgiving)
- Default T3 (aggressive cleanup, forces users to explicitly promote important content)
- Default based on source: `agent` -> T3, `cli` -> T2, `import` -> T1

**Recommendation:** Default T2 for v1. Users will be more frustrated by prematurely lost memories than by extra cleanup overhead. Once the system is live and users understand tiers, the default can be tightened. The auto-promotion mechanism (access-count-based) provides a safety net for T3 defaults in a future version.

---

**Q3. Should the user be notified when a memory is classified as T3 (transient)?**
If the user says "remember this important architectural decision" and the heuristic misclassifies it as T3, it will be silently cleaned up in 30 days. Options:
- Always show tier in `remember` response (transparent)
- Only warn if tier is T3 (noisy)
- Never show tier unless asked (clean UX)

**Recommendation:** Always include `retention_tier` and `expires_at` in the `remember` tool response. This is transparent without being noisy. The agent can mention it conversationally (e.g., "Saved as operational memory, expires in 90 days") and the user can ask to promote it.

---

### Retention Policy

**Q4. Are the default TTL values (T1=365d, T2=90d, T3=30d) appropriate?**
These are initial estimates. Consider:
- 30 days for T3 may be too short if tickets sometimes need revisiting after a month
- 90 days for T2 may be too long if the vector store fills up quickly with project context
- 365 days for T1 is generous; some institutional knowledge may not be accessed within a year but is still valuable

**Recommendation:** Ship with these defaults and add telemetry to track actual access patterns. After 90 days of production usage, analyze: "What percentage of T2 memories are accessed after 60 days? What percentage of T3 memories are accessed after 14 days?" Adjust defaults based on data. Make TTLs configurable so individual users can tune immediately.

---

**Q5. Should sliding window expiration be the default?**
Sliding window means every access resets the TTL clock. This prevents frequently-used memories from expiring but means a memory accessed once at day 29 gets another full 30-day window.

- Sliding window ON (default in spec): Memory lives as long as it's useful
- Sliding window OFF: Memory has a fixed lifespan from creation, regardless of access

**Recommendation:** Sliding window ON as default. The whole point of access-based TTL is to keep useful memories alive. Without sliding window, the system is just time-based TTL and doesn't adapt to actual usage. If a memory is worth accessing, it's worth keeping.

---

**Q6. What should happen when a tier budget is exceeded?**
If T3 hits 200,000 memories, the system needs to shed load. Options:
- Hard reject new T3 writes until cleanup runs
- Aggressive cleanup: immediately delete oldest/lowest-access T3 memories to make room
- Soft limit: allow overage, warn in health endpoint, cleanup on next cycle
- Promote overflow to archive only (no vector presence, but summary preserved)

**Recommendation:** Soft limit with aggressive next-cycle cleanup. Hard-rejecting writes is a poor user experience. When the budget is exceeded by >10%, trigger an immediate cleanup of the oldest 20% of that tier. Log a warning and report degraded health. This gives the system breathing room without blocking writes.

---

### Long-Term Knowledge

**Q7. How should T0 revision history be exposed?**
When a T0 memory is updated, the old version is archived. How should users access history?
- CLI only (`bhgbrain revisions <id>`)
- MCP tool (`tier` tool with `action: "history"`)
- MCP resource (`memory://{id}/revisions`)
- All of the above

**Recommendation:** CLI for v1, MCP resource in v2. Revision history is primarily an admin/audit function, not something agents need during normal operation. Keep the MCP contract small for v1 and add the resource when there's demand.

---

**Q8. Should T0 memories be editable by agents, or only by users?**
If an agent can update T0 (foundational) content, it could inadvertently modify critical architecture or legal information.

- Allow agent writes to T0 (flexible, trust the agent)
- Require user confirmation for T0 updates (safer, slower)
- Allow agent writes but flag for user review (compromise)

**Recommendation:** Allow agent writes to T0 but log with `source: agent` and include the change in the next `memory://inject` with a `recently_modified_t0: true` flag. This lets agents work autonomously while giving users visibility. For v2, consider a confirmation workflow for T0 modifications from agent sources.

---

**Q9. How should legal/compliance content be handled differently from other T0 content?**
Legal content may have regulatory requirements around:
- Minimum retention periods (must keep for X years)
- Maximum retention periods (must delete after Y years, e.g., GDPR)
- Access audit trails
- Content immutability (some regulations require original content preservation)

**Recommendation:** For v1, treat all T0 equally. Add a `compliance_hold` boolean field in v2 that prevents deletion even by the user and enforces audit logging on every access. Legal retention periods can be modeled as `min_retention_days` and `max_retention_days` on the memory record. This is complex enough to warrant its own spec when the use case is concrete.

---

### Operations

**Q10. How should the cleanup job handle partial failures?**
If Qdrant delete succeeds but SQLite delete fails (or vice versa), the stores are inconsistent.

- Retry the failed store (risk of infinite retry)
- Log the inconsistency and move on (eventual consistency)
- Use a two-phase commit pattern (complex, slower)
- Mark the memory as "pending_delete" and retry on next cycle

**Recommendation:** Mark as `pending_delete` and retry. Add a `delete_status` column to SQLite: `null` (normal), `pending_qdrant_delete`, `pending_sqlite_delete`. The cleanup job first processes pending deletes from prior cycles before starting new ones. This provides eventual consistency without the complexity of distributed transactions. The existing cross-store consistency pattern (spec.md: "SQLite updates are rolled back if Qdrant fails") should extend to cleanup deletes.

---

**Q11. Should archive-before-delete be mandatory or optional?**
Archiving every deleted memory adds SQLite rows and slows cleanup. Benefits:
- Users can inspect what was deleted (forensics)
- Accidentally deleted content can be recovered from summary
- Supports compliance audit trails

**Recommendation:** Optional, defaulting to ON. The archive stores only summaries (not full content or embeddings), so storage cost is minimal. Users who don't want it can set `archive_before_delete: false`. The archive table should have its own TTL (e.g., archive records older than 1 year are purged).

---

**Q12. What is the right cleanup schedule?**
Options:
- Daily at a fixed time (simple, predictable)
- Continuous background (low-latency cleanup, higher resource usage)
- On-demand only (user runs `bhgbrain gc`)
- Adaptive (more frequent when approaching budget limits)

**Recommendation:** Daily scheduled + on-demand CLI. Continuous background cleanup is unnecessary for most installations. If the vector store is small (<50k memories), daily is more than sufficient. Add an adaptive trigger: if any tier budget exceeds 90%, run cleanup immediately regardless of schedule. This handles burst scenarios (e.g., importing a large email archive).

---

### Integration

**Q13. Should the `memory://inject` payload include tier information?**
Currently inject returns memories without tier metadata. Options:
- Include `retention_tier` in each injected memory (transparent)
- Include only for T0 memories (highlight permanent knowledge)
- Don't include (keep inject payload clean)

**Recommendation:** Include `retention_tier` for all injected memories. This lets the agent reason about what's permanent vs. transient. An agent seeing a T3 memory knows it may disappear soon and can decide to promote it or note the impermanence. Minimal payload overhead (2-4 chars per memory).

---

**Q14. How should the Bootstrap Prompt (BootstrapPrompt.txt) interact with tiers?**
The bootstrap interview generates structured profile data (identity, responsibilities, entity maps). These are high-value, rarely-changing memories.

**Recommendation:** Bootstrap-generated memories should default to T0 (foundational). The bootstrap prompt should tag output with `source: import` and `tags: ["bootstrap", "profile"]`. The heuristic classifier should recognize the `bootstrap` tag as a T0 signal.

---

**Q15. Should tier classification be retroactive?**
If the classifier improves (better heuristics, new keywords), should existing memories be re-classified?

**Recommendation:** Not automatically. Provide a CLI command `bhgbrain tier reclassify --dry-run` that re-runs the classifier on all memories and shows proposed changes. The user can then apply with `bhgbrain tier reclassify --apply`. This prevents surprises (a previously T0 memory suddenly becoming T3) while allowing users to benefit from improvements.

---

## Recommendations Summary

### High Priority (implement in v1)

| # | Recommendation | Rationale |
|---|---|---|
| R1 | Heuristic classifier with LLM fallback below 0.6 confidence | Balances cost and accuracy |
| R2 | Default tier T2 for unclassified memories | Forgiving default prevents data loss |
| R3 | Always show tier in `remember` response | Transparency without noise |
| R4 | Sliding window expiration ON by default | Adapts to actual usage patterns |
| R5 | Soft budget limits with aggressive next-cycle cleanup | No write blocking, self-healing |
| R6 | Daily cleanup + on-demand CLI | Simple, predictable, sufficient for v1 scale |
| R7 | Archive-before-delete ON by default | Safety net for accidental cleanup |
| R8 | `pending_delete` status for partial failure recovery | Eventual consistency without distributed transactions |
| R9 | Include retention_tier in inject payload | Agents can reason about memory permanence |
| R10 | Bootstrap memories default to T0 | Profile data is foundational by definition |

### Medium Priority (implement before production use)

| # | Recommendation | Rationale |
|---|---|---|
| R11 | Telemetry on access patterns per tier | Data-driven TTL tuning after 90 days |
| R12 | Adaptive cleanup trigger at 90% budget | Handles burst scenarios |
| R13 | Archive table TTL (purge after 1 year) | Prevents archive from growing unbounded |
| R14 | Reclassify CLI command (dry-run + apply) | Allows classifier improvements without surprises |

### Low Priority (v2 / when needed)

| # | Recommendation | Rationale |
|---|---|---|
| R15 | MCP resource for revision history | Admin/audit feature, not agent-facing for v1 |
| R16 | T0 modification confirmation workflow | Safety for agent writes to foundational content |
| R17 | `compliance_hold` field with min/max retention | Legal retention is complex; defer until concrete use case |
| R18 | Tier-specific embedding model quality | T0 could use larger embeddings for better retrieval |

### Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Heuristic misclassifies critical content as T3 | Important memory deleted after 30 days | Sliding window + auto-promotion provides safety net; show tier in response so user can correct |
| Cleanup job fails silently | Vector store grows unbounded | Health endpoint monitors cleanup job; alert when last successful run > 48h ago |
| T0 accumulates forever, no cleanup | T0 consumes disproportionate storage | T0 has no cap in v1; monitor via `stats --by-tier`; address if T0 exceeds 10% of total storage |
| Archive table grows large | SQLite performance degrades | Archive TTL (R13) purges old records; archive stores summaries not full content |
| Tier promotion creates too many T0/T1 | Budgets ineffective | Auto-promotion only goes up one tier; cannot auto-promote to T0; promotion threshold (5 accesses) is tunable |
| Migration backfill assigns wrong tiers | Existing memories mismanaged | Backfill is conservative (defaults to T2); users can reclassify via CLI |

---

## Additional Input (Codex)

These are implementation-focused additions based on the main memory management spec.

### Additional Questions

**Q16. How should tier budgets be enforced across namespaces?**
Global tier budgets can let one noisy namespace consume most T2/T3 capacity and degrade retrieval quality for other namespaces.

**Recommendation:** Add optional namespace quotas under each tier (for example, `tier_namespace_budget_percent`) and prune within the over-budget namespace first.

---

**Q17. What is the migration/backfill plan for existing memories?**
Introducing `retention_tier`, `expires_at`, and new indexes requires backfilling existing rows and Qdrant payloads.

**Recommendation:** Add a dedicated migration command:
- `bhgbrain migrate retention --dry-run`
- `bhgbrain migrate retention --apply`

Migration behavior:
- Backfill missing tiers with current heuristics, defaulting to T2.
- Set `expires_at` from `created_at` for T2/T3, and null for T0.
- Rebuild/ensure Qdrant payload indexes after backfill.
- Emit a migration report: counts by assigned tier, rows skipped, failures.

---

**Q18. What are the restore semantics from `memory_archive`?**
The spec has `archive restore`, but behavior is underspecified:
- Restore as same tier vs downgraded tier?
- Preserve original timestamps vs create new memory?
- Re-embed full content is impossible if archive stores summary only.

**Recommendation:** In v1, define restore as:
- Create a new T2 memory from archived summary text
- Add tags `["restored", "archive"]`
- Link to original `memory_id` via metadata `restored_from`
- Treat as a new record with fresh timestamps

This avoids pretending full-fidelity restore when only summary is available.

---

**Q19. What SLOs and alerts define a healthy retention subsystem?**
Current spec mentions degraded health but not target service levels.

**Recommendation:** Add explicit SLOs and alert thresholds:
- Cleanup success rate >= 99% over 7 days
- Max cleanup lag <= 48 hours
- Pending delete backlog < 1% of total memories
- Tier classifier fallback-to-LLM rate tracked (watch for spikes)
- Budget breach duration alert if any tier > 90% for > 24 hours

---

**Q20. Should agent-originated T0 updates require stronger control?**
Allowing unrestricted agent edits to foundational/legal content is high risk.

**Recommendation:** Keep autonomy but add a guardrail:
- Agent can propose T0 update, but write as `pending_review` when tags include legal/compliance/security
- Non-sensitive T0 updates can auto-apply with full revision history
- Add a CLI approval path: `bhgbrain review pending --approve <id>`

This limits damage in the highest-risk domains without blocking normal architectural updates.

### Additional Recommended Actions

| # | Recommendation | Priority | Why |
|---|---|---|---|
| C1 | Add namespace-aware budget controls and pruning order | High | Prevents one namespace from starving others |
| C2 | Implement explicit migration/backfill command with reporting | High | Safe rollout for existing installations |
| C3 | Define archive restore as summary-based rehydration | High | Avoids false expectations of full restore fidelity |
| C4 | Add retention SLOs + health alerts | High | Makes operations measurable and actionable |
| C5 | Add `pending_review` flow for sensitive T0 updates | Medium | Reduces integrity risk on foundational knowledge |

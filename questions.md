# BHGBrain — Open Questions

Questions that need answers before or during implementation. Grouped by concern.

---

## 🧠 Memory Model

**Q1. What does "BHG" stand for?**
Is there a specific meaning or naming convention to preserve? Affects branding, package name (`bhgbrain-server`), CLI flags, etc.

**Q2. Should Claude decide what to remember, or should the user?**
Two models are possible:
- *User-driven:* User explicitly says "remember this" — Claude calls `remember`.
- *Agent-driven:* Claude autonomously decides to store things it deems important during conversation.
- *Both:* User can request, but Claude can also infer and store proactively. 
Use Both

Which is preferred? Agent-driven requires a system prompt or hook to authorize autonomous writes.

**Q3. How should duplicate or near-duplicate memories be handled?**
If the user stores "BHGBrain uses sqlite-vec" and later "sqlite-vec is the vector store for BHGBrain", should BHGBrain:
- Store both separately?
- Detect similarity (e.g., cosine > 0.92) and merge/update?
- Prompt Claude to decide? 

detect similarity

**Q4. Should there be a hard memory limit?**
e.g., max 10,000 memories, max 500MB DB. Or is the limit purely disk space?

limit database size
build a method for removing old memories.
make sure there is a way to backup and restore data

**Q5. Is "working memory" (short-lived TTL) actually needed for v1?**
It adds complexity. Could be deferred to v2 if the primary use case is long-term knowledge storage.
long-term storage

---

## 🔍 Retrieval & Search

**Q6. How should `recall` be invoked — manually or automatically?**
- *Manual only:* Claude calls `recall` when the user asks a question that seems to warrant it.
- *Auto-inject:* On session start, the MCP server pushes a memory context summary to Claude's system prompt automatically.

Auto inject.

Auto-inject is more "brain-like" but requires session lifecycle hooks. Is that in scope? yes

**Q7. What's the right default `min_score` threshold?**
0.3 cosine similarity is loose (many results). 0.6 is tighter (fewer, more precise). What does "relevant" mean to you in practice? 0.6

**Q8. Should `recall` ever return memories from *all* collections, or always scoped?**
If a user has `work` and `personal` collections, should a general recall search both unless told otherwise? All is considered work.

**Q9. Is hybrid search (semantic + full-text) required for v1?**
Pure semantic search is simpler to ship. Full-text FTS5 (SQLite) adds meaningful recall for proper nouns and exact phrases. Worth the complexity in v1? yes

---

## 🏗️ Architecture

**Q10. Local embedding is the default — is Ollama a hard requirement?**
Requiring Ollama means the user must have it running. Alternatives:
- Bundle a small embedding model directly (heavier package, ~200MB)
- Fall back to OpenAI if Ollama isn't available
- Ship with a lightweight pure-JS embedding option (lower quality but zero deps)

What's acceptable? remote is fine

**Q11. sqlite-vec vs. Qdrant — when does the upgrade happen?**
Is this a user-configurable switch, or an automatic threshold (e.g., "if > 50k memories, suggest Qdrant")? Use Qdrant

**Q12. Should the server support multiple simultaneous MCP clients?**
stdio transport is inherently single-client (one process). HTTP transport allows multiple. Is multi-client a v1 requirement (e.g., Claude CLI + a web UI at the same time)? Build for multi client support.

**Q13. Where should the database live by default?**
`~/.bhgbrain/brain.db` is proposed. Is there a preference for a different location (e.g., inside a project directory, alongside OpenBrain, or OS-specific app data paths)? proposed path of C:\Program Files\BHGBrain is where it would live on windows and the proposed path is fine.

---

## 🔐 Privacy & Security

**Q14. Should memories be encrypted at rest?**
SQLite supports SQLCipher for encrypted databases. Adds a passphrase requirement but protects data if the machine is compromised. Required, optional, or out of scope? Not in scope

**Q15. Is there a concept of "private" vs "shareable" memories?**
Example: marking a memory as private so it's excluded from any future export or sync feature.

**Q16. Should the HTTP transport have authentication?**
If enabled, a bearer token or API key would protect the memory store from other local processes or network access. Required for v1 HTTP transport? Bearer token

---

## 📦 Packaging & Distribution

**Q17. Should this be published to npm as `bhgbrain-server`?**
This enables `claude mcp add bhgbrain -- npx bhgbrain-server` with no install step. Alternatively, it could be local-only (run from source) for v1. yes

**Q18. Is a companion CLI tool wanted?**
e.g., `bhgbrain list`, `bhgbrain search "query"`, `bhgbrain forget <id>` — for managing memories outside of Claude. Or is the Claude CLI interface sufficient? Claude Cli, Codex, Gemini

**Q19. Target platforms for v1?**
- [X] Windows (PowerShell / WSL)
- [X] macOS
- [X] Linux

Any platform-specific constraints (e.g., no Ollama on Windows ARM)? ARM is not needed.

---

## 🔄 Lifecycle & Maintenance

**Q20. Should memories decay over time?**
The spec mentions an Ebbinghaus forgetting curve as a future feature. Is any form of decay — even a simple "importance drops if not accessed in 90 days" — wanted for v1? keep 180 days then look at forgetting.

**Q21. Who triggers memory consolidation (dedup/merge)?**
- On every write (expensive but immediate)? Yes
- On a scheduled background job?
- Manually by the user?
- By Claude during a "brain maintenance" session?

**Q22. Should BHGBrain integrate with or share data with OpenBrain?**
Both projects are in `C:\GitHub\`. Is there a planned relationship — e.g., BHGBrain storing memories about the brain visualization sessions, or OpenBrain reading from BHGBrain's context? Ignore openbrain as it has nothing to do with this.

---

## 🎯 Scope

**Q23. What's the MVP?**
Which of these is the minimum acceptable v1?
- [X] `remember` + `recall` + `forget` tools only (no search, no collections, no resources)
- [X] All 6 tools + resources
- [X] All tools + resources + companion CLI
- [X] All of the above + npm publish

**Q24. Is there a target timeline or milestone?**
Helps decide what to defer vs. ship. No

**Q25. Any specific use cases or workflows you want to validate first?**
e.g., "I want to be able to say 'remember this' in Claude CLI and have it available next session" — what's the scenario you most want working on day one?

I want claude to be able to remember and recall when asked to.

I also want to be able to have persistent memory categories such as Company Values, Application Archiecture, Coding Reguirements. I don't want to replace other tools such as Claude.md and other guardrail techniques but I do need to make sure there is context accross github repos for policy solver that exists in different organizations at the same time.

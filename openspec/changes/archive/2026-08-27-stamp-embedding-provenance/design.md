## Context

The embedding layer exposes `embed()` but not its own identity; callers cannot ask
"which model is this?". The config knows (`embedding.provider`, `embedding.model`,
`embedding.dimensions`, and for Azure the deployment name), so identity derivation is
pure config reading — but it must be captured *per vector at write time*, because the
whole problem is that config changes while vectors persist.

Two prior changes shape the mechanics here: `bound-restore-reconciliation`
(bounded, non-blocking batch re-embedding machinery and the `vector_synced` flag) and
`validate-supported-embedding-models` (startup model validation — this change extends
that startup surface with cross-time consistency, not just point-in-time validity).

## Goals / Non-Goals

Goals:
- Per-vector provenance stamps in both stores.
- Startup mismatch detection that is loud (health + logs) and, by default, safe
  (refuses to mix spaces).
- An operator-initiated, bounded, resumable re-embed migration.

Non-Goals:
- No automatic re-embedding (API cost must be an explicit operator decision).
- No multi-space coexistence (per-model named vectors in Qdrant is a much larger
  design; refusing mixture is the v1 answer).
- No re-embedding of archived memories (their vectors are already gone).

## Decisions

- **Identity format**: `<provider>/<model>@<dimensions>` — provider-qualified because
  the same model name served by OpenAI vs an Azure deployment is not guaranteed
  byte-identical; dimensions included because Matryoshka-truncated variants of one
  model are different spaces.
- **Expected-identity storage**: a single row in the existing SQLite config/metadata
  table, written on first stamped write ("adoption"), updated only by a completed
  re-embed. This makes mismatch detection independent of Qdrant availability at
  startup.
- **Default refuse-writes on mismatch**: mixing spaces is corruption; a hard stop
  with a clear error naming the re-embed command is kinder than quiet corrosion.
  Reads keep working (degraded relevance is better than no recall, and health says
  why).
- **Re-embed transport**: extend `repair` (it already owns cross-store reconciliation
  UX, dry-run convention, and device scoping) rather than a new tool — keeps the MCP
  surface stable; a CLI flag wraps the same code path for headless migration.
- **Resumability**: the stamp itself is the progress marker (rows still carrying the
  old identity are the remaining work), so no separate checkpoint table is needed and
  interruption at any point is safe.

## Risks / Trade-offs

- Adoption on first write means a long-lived store that never writes post-upgrade
  never records an expectation; acceptable — the first write after a model change is
  exactly the moment the guard matters.
- Refusing writes is availability-impacting by design; the flag exists for operators
  who prefer mixing over downtime, and the stamp still records what happened.
- Qdrant payload growth (~40 bytes/point) is negligible.

## Context

Server and CLI build different tool contexts, transport adapters interpret error envelopes independently, configuration parsing mutates values after validation, and startup/shutdown work escapes the main promise. Container entrypoints also expose secrets and vector ports inconsistently with the app's secure defaults. See `proposal.md` and `specs/runtime-entrypoint-contracts/spec.md`.

## Goals / Non-Goals

**Goals:**
- Make capabilities and failure meaning consistent across all entrypoints.
- Make configuration provenance, startup, background work, and shutdown explicit.
- Ship safe container and destructive-tool defaults.

**Non-Goals:**
- Removing the REST convenience routes or CLI.
- Changing MCP protocol schemas beyond corrected error and annotation semantics.

## Decisions

1. Extract one `buildToolContext` composition root with explicit mode capabilities.
- Server and CLI pass transport-specific identity/output dependencies into the same factory. Unsupported capability is a classified startup/tool error.
- Maintaining two hand-built graphs was rejected because new providers and breakers drift silently.

2. Persist bootstrap completion by collection, not by total row count.
- Each collection advances a durable hydration state; failures are isolated and health remains degraded until all discovered collections finish.
- `countMemories() === 0` was rejected because partial success permanently disables retry.

3. Export one strict error predicate and adapters per native transport.
- REST maps codes to HTTP statuses, MCP tools/resources set protocol error state, and CLI sets a non-zero exit code after printing the envelope.
- Key-presence-only predicates and unconditional HTTP 200 were rejected.

4. Separate raw file configuration from runtime overlay.
- Parse strict file config, apply typed environment values to a copy, parse the final runtime config again, and persist only raw user/device changes with atomic secure writes.
- Serializing the post-overlay object was rejected because temporary security and credential values become durable.

5. Await listener readiness and own all background handles.
- Main starts schedulers only after successful bind. Listener/fatal events enter one idempotent shutdown path; backup retries and other timers have `stop()` methods.
- Fire-and-forget startup and untracked retry timers were rejected.

6. Require typed confirmation for bootstrap reset.
- Tool annotations mark the whole bootstrap tool destructive if the SDK cannot express per-action annotations; the reset action validates an exact confirmation token.
- Relying on UI wording alone was rejected.

7. Align deployment defaults with loopback security.
- Compose binds Qdrant to loopback, generated bearer tokens stay only in a mode-restricted file, and documentation shows an explicit authenticated opt-in for external exposure.
- Printing durable tokens to logs was rejected.

## Risks / Trade-offs

- [Correct status codes break scripts that treated error bodies as success] -> Document as a behavior correction and add migration examples for curl and CLI.
- [Strict configuration rejects formerly ignored typos] -> Include precise paths and unknown-key migration messages.
- [Fatal handlers risk double shutdown] -> Reuse the existing re-entrancy guard and preserve the first non-zero exit cause.

## Migration Plan

1. Add strict/provenance-aware configuration and secure persistence.
2. Extract context/error adapters and migrate CLI, REST, MCP tools, and resources.
3. Add durable hydration state and bootstrap confirmation.
4. Await listener bind and track background handles/fatal events.
5. Update Docker defaults and README examples before release.

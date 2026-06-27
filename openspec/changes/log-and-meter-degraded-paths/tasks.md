## 1. Degraded-write observability

- [ ] 1.1 Thread a Pino logger into `WritePipeline` and emit a structured `warn` log (event, namespace, collection, embedding error) at the point the degraded-write fallback is taken (`src/pipeline/index.ts:125-130`).
- [ ] 1.2 Increment a degraded-write metric (e.g. `degraded_writes_total`) when a metadata-only unsynced row is persisted (`src/storage/index.ts`).

## 2. Degraded-startup observability

- [ ] 2.1 Emit a structured Pino `warn` at startup when the embedding provider resolves to the degraded provider, including the reason (e.g. missing credentials) (`src/index.ts`).

## 3. Retention/GC observability

- [ ] 3.1 Emit a structured Pino summary log for retention/GC runs reporting counts (stale-marked, scanned, archived, deleted) and outcome (`src/backup/retention.ts`).

## 4. Verification

- [ ] 4.1 Add tests asserting the degraded-write fallback logs/meters, the degraded startup warns, and retention runs log a structured summary.

## 5. Validation

- [ ] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.

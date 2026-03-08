## Context

Current middleware order applies auth before `/health`, conflicting with intended no-auth health checks. The rate limiter uses caller-supplied `x-client-id` as primary identity and stores buckets in an unbounded map. Resource list endpoints parse `limit` directly without range checks.

## Goals / Non-Goals

**Goals:**
- Guarantee health endpoint behavior is explicitly controlled and compatible with probes.
- Prevent trivial rate-limit bypass and unbounded bucket accumulation.
- Ensure resource list limits are validated and bounded.

**Non-Goals:**
- Introducing distributed/global rate limiting.
- Building full authN/authZ role model changes.
- Redesigning all pagination interfaces in one pass.

## Decisions

1. Exempt `/health` from bearer auth by route policy.
- Decision: Register health route before auth middleware or check `req.path === '/health'` in auth middleware.
- Rationale: Operational liveness endpoints must not depend on application credentials.
- Alternative considered: keep auth required and update probe credentials. Rejected for operational fragility.

2. Derive limiter identity from trusted context.
- Decision: Prefer authenticated principal (when available) then IP (respecting proxy config), and treat `x-client-id` as supplemental metadata only.
- Rationale: Caller-controlled headers cannot be trusted for abuse controls.
- Alternative considered: keep current behavior and document risk. Rejected due to security gap.

3. Add limiter bucket eviction.
- Decision: Store per-client buckets with TTL cleanup on window reset plus periodic sweep.
- Rationale: Prevent unbounded memory growth for high-cardinality identifiers.

4. Validate resource `limit` bounds.
- Decision: Parse and enforce integer limits with bounded range (for example 1..100) and return `INVALID_INPUT` for invalid inputs.
- Rationale: Predictable load profile and safer endpoint behavior.

## Risks / Trade-offs

- [IP-based limiting can affect NATed clients] -> Mitigation: allow configurable policy and higher defaults where needed.
- [Health unauthenticated endpoint leaks minimal service status] -> Mitigation: keep health payload minimal and non-sensitive.
- [Stricter input validation may reject previously accepted requests] -> Mitigation: document limits and return explicit validation errors.

## Migration Plan

- Implement middleware ordering/policy update for `/health`.
- Roll out limiter identity + eviction logic with metrics for bucket count and rejection rates.
- Enforce resource limit validation and update client docs/examples.
- Rollback: re-enable prior limiter strategy behind config flag if unexpected regressions appear.

## Open Questions

- Should `/metrics` follow same auth exemption policy as `/health` or stay protected?
- What default maximum should be used for resource list `limit` to balance utility and safety?

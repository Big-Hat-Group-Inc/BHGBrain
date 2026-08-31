## 1. Health Endpoint Policy

- [x] 1.1 Implement route/middleware ordering so `/health` bypasses bearer auth checks.
- [x] 1.2 Add tests for `/health` accessibility with and without configured bearer token.
- [x] 1.3 Confirm loopback enforcement behavior is unchanged for health route.

## 2. Rate Limiter Hardening

- [x] 2.1 Refactor limiter identity derivation to use trusted principal/IP and not caller-controlled header alone.
- [x] 2.2 Add bucket eviction/cleanup logic to cap long-lived in-memory state growth.
- [x] 2.3 Add tests for header-rotation bypass prevention and eviction behavior.

## 3. Resource Limit Validation

- [x] 3.1 Add parsing/validation helper for resource list `limit` with explicit min/max bounds.
- [x] 3.2 Return `INVALID_INPUT` for non-numeric and out-of-range limits.
- [x] 3.3 Add tests for invalid limits and valid bounded pagination results.

## 4. Observability and Docs

- [x] 4.1 Add metrics/logging for rate-limited requests and limiter bucket cardinality.
- [x] 4.2 Document health/auth policy and list limit constraints for API consumers.

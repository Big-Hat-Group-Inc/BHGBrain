## 1. Constant-Time Bearer-Token Comparison

- [x] 1.1 Replace the `match[1] !== expectedToken` check in `createAuthMiddleware` (`src/transport/middleware.ts:34`) with a constant-time comparison using `crypto.timingSafeEqual` over equal-length buffers.
- [x] 1.2 Guard the comparison with a length check (or compare equal-length digests) so unequal-length tokens fail without throwing and without leaking length via timing.
- [x] 1.3 Preserve existing behavior: missing header → `AUTH_REQUIRED` 401, malformed/invalid token → `auth_failed` warn + 401, no token configured → `auth_skip` + `next()`.
- [x] 1.4 Add tests asserting valid token passes, invalid token of equal and unequal length is rejected, and the comparison path uses constant-time logic.

## 2. Proxy-Aware Rate-Limit Identity

- [x] 2.1 Add a `security.trust_proxy` config option (Zod schema, default `false`) in `src/config/index.ts`.
- [x] 2.2 Call `app.set('trust proxy', config.security.trust_proxy)` in `createHttpServer` (`src/transport/http.ts`) so `req.ip` reflects the configured trust policy.
- [x] 2.3 Derive the rate-limit client identity safely: when `req.ip` is unavailable, fail closed (reject) rather than using a single shared `'unknown'` bucket; replace the magic-string fallback.
- [x] 2.4 Add tests for identity derivation with and without `trust proxy`, and for the fail-closed missing-IP path.

## 3. Instance-Scoped Limiter State

- [x] 3.1 Move `clientBuckets` and `lastRateLimitSweepAt` from module globals into the `createRateLimitMiddleware` factory closure so state is owned per middleware instance.
- [x] 3.2 Remove or replace the module-global `resetRateLimitStateForTests` coupling with an instance-scoped reset/inspection hook on the returned middleware.
- [x] 3.3 Add a test creating two independent server/middleware instances and asserting their rate-limit buckets do not interfere.

## 4. Documentation

- [x] 4.1 Document the constant-time auth comparison, the new `security.trust_proxy` config, and the loopback-only accuracy note in `README.md`, `.env.example`, and `AGENTS.md`; bump `package.json` `version`.

## 5. Validation

- [x] 5.1 Run `npm run lint`, `npm test`, and `npm run build`.

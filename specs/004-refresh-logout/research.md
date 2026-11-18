# Research: Refresh the session and log out (US-04)

Nothing was left as `NEEDS CLARIFICATION` after the spec's clarification session. Each entry gives the decision first and then the reason.

## R1. Same CQRS shape as US-01/US-02
`AuthController` dispatches `RefreshCommand` and `LogoutCommand`, which are handled by `RefreshService` and `LogoutService`. This keeps the repo consistent across stories.

## R2. Domain: `rotate(newTokenId, now)` and `isUsable(now)`
`isUsable(now)` returns `revokedAt === null && now < expiresAt`. `rotate()` sets `revokedAt = now` and `replacedBy = newTokenId`, and throws if the token is not usable. `RefreshToken.issueInFamily({ userId, familyId, tokenHash, issuedAt, expiresAt })` creates the successor with a new id, so the rotation rules live in the domain.

## R3. Classifying failures in the domain
`RefreshToken.assess(now)` returns a `RefreshTokenState`: `REUSED` if the token is revoked (checked first, so a token that is both expired and revoked counts as reuse), `EXPIRED`, or `USABLE`. The handler only branches on that result.

## R4. Session limit as a family-level rule
`TokenFamily` is a domain value object holding `startedAt` and `maxSeconds`. Its `expiresAt` is `startedAt + max`. `nextTokenExpiry(now, refreshTtl)` returns `min(now + ttl, expiresAt)` and throws `SESSION_EXPIRED` if that is `<= now`. The rule is pure and unit-tested.

## R5. Session start is derived, so there is no new column
The session start is `MIN("createdAt")` over the family, read through the existing `IDX_refresh_tokens_family_id`. A `sessionStartedAt` column was rejected: deriving the value avoids a migration, and a change to `JWT_SESSION_MAX_SECONDS` also applies to existing sessions.

## R6. No migration
The family lookup index (`IDX_refresh_tokens_family_id`) and the unique hash index (`UQ_refresh_tokens_token_hash`) already exist, and so do all the columns.

## R7. Transaction scope lives in the repository
`RefreshTokenRepository.inTransaction(work)` passes the work a `RefreshTokenTx` with these methods: `findByHash`, `findByHashForUpdate`, `lockFamily`, `findUserById`, `familyStartedAt`, `revokeFamily`, and `saveRotation(rotated, next)`. The service orchestrates without touching TypeORM (Principle I).

## R8. Fail after commit
The transaction callback returns an outcome union (`issued` | `refused(reason)`), and the handler throws `InvalidRefreshTokenError` only after the commit. Throwing inside the callback would roll back the family revocation that reuse and inactive users require.

## R9. Locking: the token row plus the family
The token is first read by hash without a lock, only to learn its `familyId`. Then `pg_advisory_xact_lock(hashtextextended(familyId, 0))` serializes every rotate, revoke and logout of one family, and the row is read again with TypeORM `lock: { mode: 'pessimistic_write' }` (`SELECT … FOR UPDATE`). The family lock MUST come before any row lock: a transaction holding a row lock while waiting for the family lock would deadlock with a reuse that holds the family lock and is blocked in `revokeFamily` on that row (`40P01` → 5xx). With the row lock alone, a reuse running at the same time as a legitimate rotation of the newest token can miss the row that rotation inserts (under READ COMMITTED, the UPDATE's snapshot was taken earlier). The advisory lock is per transaction and is released on commit or rollback.

## R10. Two refreshes at the same moment
The loser waits on the family lock and then reads the committed `revokedAt`. `assess` returns `REUSED`, so the whole family is revoked, including the winner's new token (spec US2-AS3). This needs no extra code path.

## R11. Order of checks in refresh
1. Hash the token.
2. Read the token by hash; if it is unknown, refuse with `UNKNOWN`. Otherwise take the family lock, then re-read the row `FOR UPDATE`.
3. If `assess` returns `REUSED`, revoke the family and refuse.
4. If it returns `EXPIRED`, refuse without revoking.
5. Load the user. If the user is not `canLogin()`, revoke the family and refuse.
6. Compute the next expiry from `TokenFamily`.
7. Issue the access token with `TokenIssuer`, using the current roles and `customerId`.
8. Create the successor with `issueInFamily`, then call `rotate`, then `saveRotation`.

Steps 3–5 are one pure domain call, `RefreshPolicy.decide({ token, user, now })`, returning `rotate` or `refuse(reason, revokeFamily)`; the handler loads the user first and only executes the decision (Principle I: which failures revoke the family is business logic).

## R12. Signing inside the transaction
Signing is in-memory RS256 and fast. If the commit fails, the signed token is discarded and never returned, so FR-003 holds.

## R13. One error type for refresh
`InvalidRefreshTokenError` (in `src/domain/errors/`) carries `reason: RefreshFailureReason` (`UNKNOWN`, `EXPIRED`, `REUSED`, `INACTIVE_USER`, `SESSION_EXPIRED`), and the reason is only logged. The controller maps it to `UnauthorizedException('invalid refresh token')`, so the body is byte-identical for every reason (SC-004). Other errors propagate and become 5xx.

## R14. Logout always returns 204
`LogoutService` hashes the token. In one transaction it finds the token by hash (no lock), takes the family lock and revokes every unrevoked row. An unknown token is a no-op. The controller uses `@HttpCode(204)` and returns no body. A database error still becomes 5xx (spec edge case).

## R15. DTO
`RefreshTokenDto` has a single field, `refreshToken: string`, validated with `@IsString`, `@IsNotEmpty` and `@MaxLength(512)` so huge values are not hashed. Both endpoints use it. Validation rejects unknown properties. The refresh response reuses `LoginResponseDto`.

## R16. Throttling
- Two new named throttlers, `refresh` and `logout`, keyed by IP (`req.ip`). They are configured by `RATE_LIMIT_REFRESH_LIMIT`/`_TTL_MS` and `RATE_LIMIT_LOGOUT_LIMIT`/`_TTL_MS`, both defaulting to 30 per 60000 ms.
- Every route skips the throttlers that are not its own. Existing routes add skips for the two new names.

## R17. Configuration
- `JWT_SESSION_MAX_SECONDS` defaults to 2592000 and is parsed with `parseNonNegativeInteger`.
- The configuration loader throws `JWT_SESSION_MAX_SECONDS must be >= JWT_REFRESH_TTL_SECONDS`, so a bad combination fails at startup.

## R18. Logging
- `refresh succeeded`, `refresh refused reason=…`, `refresh token reuse detected` (warn) and `logout` are logged with `userId`, `familyId` and `ip`.
- No line includes a token value or hash. The capturing-logger component test checks this (SC-007).

## R19. Kafka is not involved
Refresh and logout publish nothing. The component test runs with the broker on a closed port, as in the US-02 test.

## R20. ADR 0002 gets an update, not a replacement
The rotation and reuse approach is unchanged. A dated "Update (US-04)" section records:
- the absolute session limit and how its start is derived;
- strict reuse detection with no grace window;
- the family advisory lock;
- logout revoking the family;
- the purge job still being deferred.

# Data Model: Refresh the session and log out (US-04)

The schema does not change. `refresh_tokens` (US-02) already has every column and index this story needs (research R5, R6).

## RefreshToken aggregate (`src/domain/refresh-token.aggregate.ts`): additions

| Member | Rule |
|---|---|
| `static issueInFamily({ userId, familyId, tokenHash, issuedAt, expiresAt })` | Creates the successor: new `id`, the given family, not revoked. Throws if the hash is empty or `expiresAt <= issuedAt`. |
| `assess(now): RefreshTokenState` | Returns `REUSED` if `revokedAt !== null` (this check runs first), otherwise `EXPIRED` if `now >= expiresAt`, otherwise `USABLE`. |
| `isUsable(now): boolean` | Same as `assess(now) === USABLE`. |
| `rotate(newTokenId, now)` | Sets `revokedAt = now` and `replacedBy = newTokenId`. Throws if `!isUsable(now)` or the id is empty. |

`RefreshTokenState` is an enum with the values `USABLE`, `EXPIRED` and `REUSED`.

### State transitions

```text
ACTIVE(revokedAt=null, now<expiresAt) ──rotate──▶ ROTATED(revokedAt=t, replacedBy=next)
ACTIVE ──family revoke (reuse / logout / inactive user)──▶ REVOKED(revokedAt=t, replacedBy=null)
ACTIVE ──time passes──▶ EXPIRED (stored state unchanged; not revoked)
ROTATED | REVOKED ──presented again──▶ family revoke + 401
```

## TokenFamily value object (`src/domain/token-family.ts`): new

| Field / method | Rule |
|---|---|
| `startedAt: Date` | The `MIN(createdAt)` of the family, which is the login time. |
| `maxSeconds: number` | Comes from `JWT_SESSION_MAX_SECONDS` and must be positive. |
| `expiresAt` | Equal to `startedAt + maxSeconds`. |
| `nextTokenExpiry(now, refreshTtlSeconds)` | Returns `min(now + ttl, expiresAt)`. Throws `InvalidRefreshTokenError(SESSION_EXPIRED)` if the result is `<= now`. |

## RefreshPolicy (`src/domain/refresh-policy.ts`): new

`decide({ token, user, now }): RefreshDecision` = `{ kind: 'rotate' } | { kind: 'refuse', reason, revokeFamily }`. Order: revoked → `REUSED` + revoke; expired → `EXPIRED`, no revoke; user not `canLogin()` → `INACTIVE_USER` + revoke; else rotate. Pure; the service only executes it.

## InvalidRefreshTokenError (`src/domain/errors/invalid-refresh-token.error.ts`): new

- Has one fixed message, `invalid refresh token`.
- Has `reason: RefreshFailureReason`, with the values `UNKNOWN`, `EXPIRED`, `REUSED`, `INACTIVE_USER` and `SESSION_EXPIRED`. The reason is logged and never returned to the client.

## User (existing)

Refresh reads `status` (through `canLogin()`), `roles` and `customerId`, and changes nothing on the user. `lastLoginAt` is not updated, because a refresh is not a login.

## Persistence operations (`RefreshTokenTx`, one transaction)

| Operation | SQL shape |
|---|---|
| `findByHash(hash)` | `SELECT … WHERE "tokenHash" = $1`, no lock; only learns `familyId`. Lock order is always `findByHash` → `lockFamily` → `findByHashForUpdate` (R9). |
| `findByHashForUpdate(hash)` | `SELECT … WHERE "tokenHash" = $1 FOR UPDATE` (TypeORM `pessimistic_write`) |
| `lockFamily(familyId)` | `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` |
| `familyStartedAt(familyId)` | `SELECT MIN("createdAt") … WHERE "familyId" = $1` (uses `IDX_refresh_tokens_family_id`) |
| `revokeFamily(familyId, at)` | `UPDATE … SET "revokedAt" = $2 WHERE "familyId" = $1 AND "revokedAt" IS NULL` |
| `saveRotation(rotated, next)` | `UPDATE` sets the old row's `revokedAt` and `replacedBy`, then `INSERT`s the new row |
| `findUserById(id)` | Reads the user with the same manager and maps it to `User` with the `UserRepository` mapper |

## Configuration

| Key | Env | Default | Validation |
|---|---|---|---|
| `jwt.sessionMaxSeconds` | `JWT_SESSION_MAX_SECONDS` | `2592000` | Must be a non-negative integer and at least `JWT_REFRESH_TTL_SECONDS`; startup fails otherwise. |
| `rateLimit.refresh` | `RATE_LIMIT_REFRESH_LIMIT` / `_TTL_MS` | `30` / `60000` | None |
| `rateLimit.logout` | `RATE_LIMIT_LOGOUT_LIMIT` / `_TTL_MS` | `30` / `60000` | None |

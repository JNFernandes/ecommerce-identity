# Data Model: US-07

There are no new tables, columns or indexes. `users.status` (`user_status_enum`: `ACTIVE`, `DISABLED`) and `refresh_tokens.revokedAt` already exist, and `IDX_refresh_tokens_user_id` serves the revocation.

## `User` aggregate (existing, extended)

| Member | Rule |
|---|---|
| `disable(actingAdminId: string, at: Date): boolean` | Throws `CannotDisableSelfError` if `id === actingAdminId` (checked first). Already `DISABLED` → `false`, no change. Otherwise → `DISABLED`, `updatedAt = at`, returns `true` |
| `enable(at: Date): boolean` | Already `ACTIVE` → `false`. Otherwise → `ACTIVE`, `updatedAt = at`, returns `true`. Never touches tokens |
| `isActiveAdmin(): boolean` | `status === ACTIVE && roles.includes(ADMIN)` |

### State transitions

```text
ACTIVE --disable(other admin)--> DISABLED   (+ every refresh token revoked, same transaction)
DISABLED --enable--> ACTIVE                 (revoked tokens stay revoked)
same status --> no-op (200, nothing written or logged)
```

## `LastActiveAdminPolicy` (domain, new)

`assertCanDisable({ target: User; activeAdminCount: number }): void` throws `LastActiveAdminError` when `target.isActiveAdmin()` and `activeAdminCount <= 1`. It is called only for an effective disable of an `ADMIN`, with the count read before the write.

## Domain errors (new)

| Error | Message | HTTP |
|---|---|---|
| `CannotDisableSelfError` | `an admin cannot disable their own account` | 409 |
| `LastActiveAdminError` | `the last active admin cannot be disabled` | 409 |
| `UserNotFoundError` (existing) | `user not found` | 404 |
| `InvalidAccessTokenError(USER_UNAVAILABLE)` (existing) | `unauthorized` | 401 (acting admin missing or not `ACTIVE`) |

## `ChangeUserStatusCommand` (new)

`targetId: string` (UUID), `status: UserStatus`, `actingAdminId: string` (the token's `sub`). The result is a `UserSummaryReadModel` (existing US-06 read model).

## `UserStatusTx` (repository transaction port, new)

| Method | SQL intent |
|---|---|
| `lockStatusChanges()` | `pg_advisory_xact_lock(<constant>)` |
| `findById(id)` | plain read |
| `findByIdForUpdate(id)` | `SELECT … FOR UPDATE` |
| `countActiveAdmins()` | `COUNT(*) WHERE status='ACTIVE' AND 'ADMIN'=ANY(roles)` |
| `saveStatus(user)` | `UPDATE users SET status, "updatedAt" WHERE id` |
| `revokeAllRefreshTokens(userId, at)` | `UPDATE refresh_tokens SET "revokedAt"=at WHERE "userId"=… AND "revokedAt" IS NULL`; returns count |

## Changes to existing flows

| Flow | Change |
|---|---|
| Refresh (`RefreshTokenTx`) | + `lockUserForShare(userId)` (`SELECT … FOR SHARE`), called after `findByHash` and before `lockFamily` |
| Login (`saveWithLogin`) | The `lastLoginAt` update adds `AND status='ACTIVE'`. When 0 rows are affected, it throws `InvalidCredentialsError` and inserts no token |

## DTOs

- `ChangeUserStatusDto`: `status` with `@IsEnum(UserStatus)`, required; there are no other fields.
- The response is the existing `UserSummaryResponseDto`.

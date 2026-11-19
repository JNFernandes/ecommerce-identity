# Research: Enable or disable a user (US-07)

No `NEEDS CLARIFICATION` remained after the clarification session. Each entry gives the decision, then the reason.

## R1. Self rules on the aggregate
`User.disable(actingAdminId, at)` and `User.enable(at)` return `true` when the status changed and `false` for a no-op. `disable` throws `CannotDisableSelfError` when `id === actingAdminId`, before checking the current status. Rules about the user itself belong to the aggregate (Principle I), and the boolean drives "no log, no revocation" for no-ops (FR-005).

## R2. Last-active-admin rule as a domain policy
`LastActiveAdminPolicy.assertCanDisable({ target, activeAdminCount })` throws `LastActiveAdminError` when the target is an `ACTIVE` `ADMIN` and `activeAdminCount <= 1`. The handler first calls `user.assertCanBeDisabledBy(actorId)` (the self rule, which `disable` also uses), then the policy on the unchanged target, then `disable`. So the self-disable error wins when both apply (spec assumption), and the policy sees the target before the change. The rule is domain; the count is a repository fact passed in.

## R3. Serialize status changes with one advisory lock (deviation from the input)
Every status change first takes `pg_advisory_xact_lock(<constant key>)`, then locks the target row `FOR UPDATE`. The input asked to lock the target, then lock and count the active admins in id order. With crossed disables (A→B, B→A), each transaction would already hold its target, then wait for the other's row: a deadlock that PostgreSQL aborts with a 500. Only this endpoint changes `status`, and the seed only adds an admin when none exists. So one transaction-wide lock makes the actor re-read and the admin count exact without row locks, with no lock-order risk. The cost is negligible because status changes are rare admin actions.

## R4. Target row `FOR UPDATE` still taken
This lock serializes the change with login and refresh (R6, R7), so no refresh token is issued around a disable.

## R5. Acting admin re-read (FR-016)
Inside the transaction, after the advisory lock, `findById(actorId)`. When the actor is missing or not `ACTIVE`, the handler throws `InvalidAccessTokenError(USER_UNAVAILABLE)`. The existing global filter turns it into the byte-identical generic 401. In the crossed-disable race, the loser therefore gets 401 (spec US3-AS3 updated).

## R6. Refresh takes the user row `FOR SHARE` (fixes a race)
Today refresh reads the user without a lock. A refresh that read `ACTIVE` could insert its successor after the disable's `UPDATE … revokedAt` statement started, leaving an unrevoked token that would become usable after a re-enable. Fix: `RefreshTokenTx.lockUserForShare(userId)` runs right after `findByHash` and before `lockFamily`. The disable then waits for in-flight refreshes, or the refresh sees `DISABLED`. Lock order for a refresh: user share → family → token row. A disable never waits on a family lock, so no cycle.

## R7. Login writes `lastLoginAt` only while `ACTIVE` (fixes a race)
`saveWithLogin` becomes `UPDATE users SET "lastLoginAt" … WHERE id = $1 AND status = 'ACTIVE'`. When 0 rows are affected, it throws `InvalidCredentialsError` and inserts no token, so the caller gets the generic 401. Under READ COMMITTED, PostgreSQL re-checks the `WHERE` after waiting on the disable's row lock. This closes the gap between the status check and the token insert.

## R8. Revoke every token of the user
`UserStatusTx.revokeAllRefreshTokens(userId, at)` sets `revokedAt` where `userId = $1 AND "revokedAt" IS NULL` and returns the count (for the log). It uses the existing `IDX_refresh_tokens_user_id`, so no migration is needed. Already-revoked rows keep their `revokedAt` and `replacedBy` (edge case).

## R9. Transaction port in the repository
`UserRepository.inStatusTransaction(work)` hands `work` a `UserStatusTx`. Its methods are `lockStatusChanges`, `findById`, `findByIdForUpdate`, `countActiveAdmins`, `saveStatus` (writes only `status` and `updatedAt`) and `revokeAllRefreshTokens`. It mirrors `RefreshTokenRepository.inTransaction`, and keeping the writes narrow satisfies FR-015.

## R10. Command handler
`ChangeUserStatusCommand(targetId, status, actingAdminId)` is handled by `ChangeUserStatusService` (`@CommandHandler`). The transaction runs: lock → actor → target (404 `UserNotFoundError`) → domain → (`DISABLED` and target `ADMIN`: count + policy) → `saveStatus` → (`DISABLED`: revoke). It returns the `UserSummaryReadModel` built from the updated aggregate, so the response matches `GET /users/{id}` (FR-002).

## R11. Errors → HTTP in the controller
`CannotDisableSelfError` → 409 `an admin cannot disable their own account`. `LastActiveAdminError` → 409 `the last active admin cannot be disabled`. `UserNotFoundError` → 404 (its JSDoc is generalized). A missing or disabled actor goes through the existing 401 filter.

## R12. Input validation
`ParseUUIDPipe` on `id`. `ChangeUserStatusDto` has `status` with `@IsEnum(UserStatus)`. The global pipe (`whitelist`, `forbidNonWhitelisted`) already rejects unknown fields, and `disabled`, a number or a missing value get a 400 with details. A malformed JSON body gets 400 from the body parser.

## R13. Logging
After the commit, an effective change logs `user status changed: actorId=… targetId=… from=ACTIVE to=DISABLED revokedTokens=N`. No-ops log nothing at `log` level. There are no emails, names or tokens (FR-011). A component test scans captured logs.

## R14. No event, Kafka independent
Nothing is published and the handler has no producer dependency (FR-012). A component test runs with Kafka on a closed port.

## R15. ADR 0006
"Status changes are serialized; disabling revokes sessions; access tokens expire naturally." It records R3, R6 and R7 and the access-token trade-off, because those cross-flow lock rules are not visible from one file.

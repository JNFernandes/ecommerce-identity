# 0006. Status changes are serialized; disabling revokes sessions; access tokens expire naturally

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

US-07 lets admins disable and re-enable users through `PATCH /users/{id}/status`. Three things must
hold under any concurrency:

- There is always at least one `ACTIVE` admin, even when two admins disable each other at once.
- No refresh token of a disabled user stays usable, including one issued by a refresh or a login
  that was in flight when the disable ran. Otherwise a re-enable would bring that session back.
- An admin disabled after their token was issued cannot keep changing statuses.

The first design locked the target row, then locked and counted the active admins in id order.
With crossed disables (A disables B while B disables A), each transaction already holds its target
row and then waits for the other's row. That is a deadlock, which PostgreSQL aborts, and the client
would get a 500.

Access tokens are stateless RS256 JWTs (ADR 0001), verified locally by this service and downstream
services (ADR 0005). Revoking them would need a deny list or a per-request lookup everywhere.

## Decision

We will serialize every status change with one transaction-scoped advisory lock
(`pg_advisory_xact_lock(USER_STATUS_LOCK_KEY)`, a two-integer key that never overlaps the 64-bit
refresh-family keys). In one transaction the handler then:

1. re-reads the acting admin and answers the generic `401` unless they are an `ACTIVE` admin;
2. locks the target row `FOR UPDATE`;
3. checks the self rule, then counts the `ACTIVE` admins (exact, because only this endpoint changes
   `status`) and applies `LastActiveAdminPolicy`;
4. writes the status and, when disabling, revokes every refresh token of the user.

Crossed disables are therefore ordered: the first wins, and the second sees its own actor
`DISABLED` and gets `401`.

We will close the two token races with the target row lock:

- Refresh takes `SELECT … FOR SHARE` on the user row right after `findByHash` and before the family
  lock. A disable waits for an in-flight refresh and then revokes its successor, or the refresh
  waits for the disable and sees `DISABLED`. A disable never takes a family lock, so there is no
  lock cycle.
- Login's `saveWithLogin` updates `lastLoginAt` only `WHERE status = 'ACTIVE'`. Under READ
  COMMITTED, PostgreSQL re-checks that condition after waiting on the disable's row lock. With 0
  rows, the login throws the generic `InvalidCredentialsError` and inserts no token.

We will not revoke access tokens. A disabled user's access tokens expire naturally, after at most
`JWT_ACCESS_TTL_SECONDS` (15 minutes by default).

## Consequences

- At least one `ACTIVE` admin always remains, and crossed disables end in `200` + `401`, never a
  deadlock or a 500.
- Disabling ends every session at once: refresh and login refuse the user, and no in-flight flow
  can leave a usable refresh token behind. Re-enabling restores login but no old session.
- Status changes run one at a time across the service. They are rare admin actions, so the
  contention cost is negligible.
- Refresh now takes one more lock, a shared row lock that does not block other refreshes.
- Trade-off: a disabled user's access tokens keep working on token-only routes, here and
  downstream, until `exp`. Routes that read the user (`GET /users/me`, this endpoint) refuse at
  once. A shorter `JWT_ACCESS_TTL_SECONDS` narrows the window. A deny list is possible future work.
- The lock order is a cross-flow rule that no single file shows. It is documented on `UserStatusTx`,
  `RefreshTokenTx` and in `src/README.md`, and covered by the `user-status-locking` integration
  tests.

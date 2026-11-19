# 0010. Role changes keep the customerId and share the admin-changes lock

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

US-10 adds `PUT /users/{id}/roles` (ADR 0008). Three questions were open
(constitution TODO(ROLE_CHANGE_CUSTOMER_ID)):

- What happens to `customerId` when `CUSTOMER` is granted to a user who never had one, or removed?
  Orders creates its customer record only from `identity.user-registered` (ADR 0004).
- How do role changes and status changes (ADR 0006) stay race-safe together, so that a demotion
  and a disable on the last two admins cannot leave zero `ACTIVE` admins?
- Which sessions end on a role change, given access tokens cannot be revoked (ADR 0006)?

## Decision

We will allow a user to hold `CUSTOMER` and `ADMIN` at once (`POST /users` still creates one role).

We will create a `customerId` on the first `CUSTOMER` grant to a user without one and publish
`identity.user-registered` after the commit, with the US-01 payload and the dead-letter fallback.
Removing `CUSTOMER` keeps the `customerId`: it becomes dormant, stays visible to admins and is never
put in an access token. A later grant reuses it and publishes nothing. `ADMIN` never touches it.

We will run role changes under the same transaction-scoped advisory lock as status changes
(`lockAdminChanges`), in the same order: re-read the acting admin (generic `401` unless an `ACTIVE`
admin), lock the target row, check (no-op, then self rule, then last-active-admin count), write,
revoke, audit.

We will revoke every refresh token of the target when any role is removed, and none on a grant.
Access tokens keep their roles until they expire.

## Consequences

- Orders learns about every customer, whichever way they got `CUSTOMER`, and never twice for the
  same user. A dormant `customerId` stays reserved; Orders keeps its record.
- Concurrent role and status changes are serialized, so at least one `ACTIVE` admin always
  remains; crossed demotions end in `200` + `401`. Sequentially the last-admin `409` is
  unreachable (an acting admin is itself an `ACTIVE` admin), but the check stays as a safeguard.
- A demoted user must log in again to get a token with the reduced roles; a promoted user gets the
  new roles at the next refresh or login. Trade-off: old access tokens keep their roles for at most
  `JWT_ACCESS_TTL_SECONDS`.
- The token issuer, not the callers, hides a dormant `customerId`, so every flow that issues a
  token gets the rule.

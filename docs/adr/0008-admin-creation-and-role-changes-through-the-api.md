# 0008. Admins create users and change roles through the API, with audit

- **Status**: Accepted
- **Date**: 2026-11-19
- **Supersedes**: [0003](0003-admin-seed-and-no-role-change.md)

## Context

ADR 0003 allowed admins only from the startup seed and no role change through the API, to keep
privilege escalation impossible at runtime. In practice this means a second admin, or demoting
one, needs a deployment-level action, and there is no record of who changed what.

The risks that motivated 0003 still apply: a role-granting endpoint is a privilege-escalation
target (a guard bug, mass assignment of a `roles` field, a stolen admin token), and a careless
demotion could leave the system with no active admin.

Constitution 1.1.0 (Principles II, III and XI) now allows role management through the API under
strict rules and requires an audit trail for administrative changes.

## Decision

- Public registration still **always** creates a `CUSTOMER`; a role in the request is never
  honoured.
- `ADMIN` users are created by the startup seed (unchanged) **or** by an `ADMIN` through
  `POST /users`. The admin supplies the initial password, which follows the registration password
  policy and is never logged, returned or audited.
- Roles change **only** through `PUT /users/{id}/roles`, called by an `ADMIN`. No self-service: a
  `CUSTOMER` can never change a role, and no other endpoint touches roles.
- A user cannot remove their own `ADMIN` role, and the last `ACTIVE` admin can never lose `ADMIN`
  or be disabled. These checks are race-safe.
- Every user creation by an admin, role change and status change writes an append-only audit
  record (`actorId`, `action`, `targetId`, `before`, `after`, timestamp) in the same transaction
  as the change. Records are never updated or deleted, never contain passwords, hashes or tokens,
  and are readable only by `ADMIN` through `GET /audit`.
- `POST /users/me/password` lets any signed-in user change their own password: it requires the
  current password, applies the registration policy and revokes the user's other sessions.

Rejected alternatives:

- **Keep 0003 (seed only).** Safe, but every admin change needs a redeploy and leaves no trail.
- **Generated one-time password or invitation link for admin-created users.** Better secrecy, but
  needs email delivery or a token flow, and email is out of scope.
- **Audit through application logs.** Logs are not transactional, can be lost, rotated or edited,
  and are not queryable through the API.

## Consequences

- Admins can be added and demoted at runtime, without touching the deployment.
- Privilege changes are restricted to `ADMIN` callers and are fully traceable through `GET /audit`.
- The audit table grows forever; purging or archiving it would need a future amendment.
- The admin who creates a user knows that user's first password. The README recommends that the
  user changes it with `POST /users/me/password` after the first login.
- Role changes still take effect for access tokens only when they expire (at most the access token
  lifetime); login and refresh read the current roles.
- Follow-ups: `PATCH /users/{id}/status` (US-07) must start writing audit records; the specs of the
  new stories must settle the open points listed in the constitution's Sync Impact Report
  (customers created by an admin, `customerId` on role changes, which session survives a password
  change, rate limiting of the password change).

# 0003. Admins only from a startup seed; no role-change endpoint

- **Status**: Superseded by [0008](0008-admin-creation-and-role-changes-through-the-api.md)
- **Date**: 2026-11-17

## Context

There are exactly two roles, `CUSTOMER` and `ADMIN`. Anyone can register, so registration must
never yield an admin. The system still needs at least one admin to list users and disable them.

Any API that grants or changes roles is a privilege-escalation target: a bug in its guard, a
mass-assignment of a `roles` field, or a stolen admin token would let an attacker create more
admins. Self-service role management is not needed at this stage.

## Decision

- Public registration (`POST /auth/register`) **always** creates a `CUSTOMER` with a new
  `customerId`. Any role in the request is rejected by validation (`forbidNonWhitelisted`).
- `ADMIN` users are created **only** by a startup seed from `ADMIN_EMAIL` and `ADMIN_PASSWORD`,
  and only when no admin exists. Admins have no `customerId`.
- **No endpoint changes a user's role.** Admins can only change a user's status
  (`PATCH /users/{id}/status`).
- Changing roles through the API is out of scope until the constitution is amended.

## Consequences

- The only way to become an admin is to control the deployment's environment, which is already
  the highest privilege.
- The admin password lives in deployment configuration; it is hashed with argon2id when seeded and
  must be handled as a secret.
- Creating a second admin or demoting one requires a deployment-level action (or a future
  amendment and ADR); there is no runtime workflow for it.
- Role changes made outside the API take effect for access tokens only when they expire; login and
  refresh read the current roles.
- Follow-up (done in US-06, `specs/006-admin-seed-list-users/`): `AdminSeedService` creates the
  admin at startup only when none exists, never modifies or promotes an existing user, publishes
  no event and never logs the password; restarts and concurrent starts leave exactly one admin.

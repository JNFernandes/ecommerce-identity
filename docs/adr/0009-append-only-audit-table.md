# 0009. Audit records in an append-only table guarded by a trigger

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

Constitution 1.1.0 (Principle XI) requires every administrative mutation (user creation by an admin,
role change, status change) to write an audit record **in the same transaction** as the change,
and audit records must never be updated or deleted nor contain passwords, hashes or tokens.
US-09 (`POST /users`) is the first mutation that needs it; the read endpoint `GET /audit` comes in
US-11, so only the write side is built now.

## Decision

- A table `audit_records` (`id`, `actorId`, `action`, `targetId`, `before` jsonb null, `after`
  jsonb, `occurredAt`) is created by a migration. A row-level trigger
  `audit_records_append_only` (`BEFORE UPDATE OR DELETE`) raises `audit records are append-only`,
  so the guarantee holds for any client of the database, not only for this service's code.
- The application only ever inserts: `AdminTx.appendAudit` runs a plain `INSERT` in the same
  admin transaction as the change, after the change itself.
- `action` is a `varchar(64)` holding the domain `AuditAction` enum; new actions need no migration.
- `actorId` and `targetId` have no foreign keys: the trail is history and must outlive any later
  change to users.
- `before` / `after` are built by the domain (`AuditRecord`) from non-secret fields only (roles,
  statuses), never from emails, names, passwords, hashes or tokens.
- No secondary index yet: US-11 adds the ones its queries need.

Rejected alternatives:

- **Log line only.** Not transactional (a change could commit without its trace, or the reverse)
  and not durable, queryable storage; violates Principle XI.
- **Append-only enforced by code only.** A future bug, a migration script or manual SQL could
  still rewrite history; the trigger makes tampering fail loudly.
- **PostgreSQL enum for `action`.** Every new action would need an `ALTER TYPE` migration.
- **Foreign keys to `users`.** Couples the trail to the user lifecycle.

## Consequences

- A change and its audit record commit or roll back together; a failed audit write fails the
  request.
- Rows can never be corrected in place: a wrong record stays, and only a new record can explain it.
- `TRUNCATE` is not blocked by the trigger; it is an operator action, never used by the service.
- The table grows forever; archiving or purging needs a future amendment.
- Follow-ups: US-10 (role changes) and the US-07 follow-up (status changes) append their own
  actions through the same `AdminTx`; US-11 adds `GET /audit` and its indexes.

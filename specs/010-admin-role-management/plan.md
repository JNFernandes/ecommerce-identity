# Implementation Plan: An administrator assigns and revokes roles (US-10)

**Branch**: `feature/US-10-admin-role-management` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

## Summary

`PUT /users/{id}/roles` (ADMIN) replaces a user's roles. Mirrors US-07: one `AdminTx` transaction
(advisory lock → re-read actor → lock target → domain → persist → revoke if a role was removed →
audit), then publish `identity.user-registered` after commit on a first `CUSTOMER` grant.

## Technical Context

- **Stack**: TypeScript strict, NestJS 10 CQRS, TypeORM + PostgreSQL, kafkajs, Jest + testcontainers.
- **Storage**: existing `users` (roles, nullable unique `customerId`), `refresh_tokens`,
  `audit_records`, `outbound_dead_letters`. No new table; a migration only if the audit `action`
  column is a DB enum/check (add `ROLES_CHANGED`).
- **Constraints**: race-safe last-admin rule shared with status changes (same advisory lock);
  works with Kafka down. No NEEDS CLARIFICATION.

## Constitution Check

| Principle | Status |
|-----------|--------|
| I Layering | PASS: rules in `User.changeRoles` + `LastActiveAdminPolicy`; service orchestrates. |
| II Security | PASS: no secrets in logs/audit; revocation on removal. |
| III Roles | PASS after PATCH amendment (FR-014a): admins created by seed/`POST /users` have no `customerId`; a kept `customerId` is dormant without `CUSTOMER`. |
| IV Write flow | PASS: commit first, then publish; dead-letter fallback with same `eventId`. |
| V Validation | PASS: DTO whitelist, `forbidNonWhitelisted`, `ArrayNotEmpty`, `ArrayUnique`, `IsEnum`. |
| VI/VII Tests | PASS: unit (domain), integration (repo/locking), component (endpoint, concurrency, Kafka down). |
| XI Audit | PASS: `ROLES_CHANGED` in same tx, before/after roles only. |

## Design decisions

- **Domain**: `User.changeRoles(roles, actorId)` → returns `{ changed, removed: Role[], customerCreated }`;
  no-op when sets are equal (checked before safeguards); throws `CannotRemoveOwnAdminError` (409).
  On first `CUSTOMER` grant without `customerId`, creates one (≠ id) and records `UserRegistered`.
- **Last admin**: add `LastActiveAdminPolicy.assertCanRemoveAdmin({ target, activeAdminCount })`
  reusing `LastActiveAdminError` (409); count under the shared `lockAdminChanges` advisory lock, so
  concurrent role + status changes serialize (ADR 0006).
- **Persistence**: `AdminTx.saveRoles(user)` (roles + `customerId`); reuse `findByIdForUpdate`,
  `countActiveAdmins`, `revokeAllRefreshTokens`, `appendAudit`.
- **Audit**: `AuditAction.ROLES_CHANGED`, `AuditRecord.rolesChanged(actor, user, before, now)`.
- **Event**: reuse `UserEventDispatcher` (as `CreateUserService`) after commit.
- **Token (FR-008a)**: `JoseTokenIssuer` adds `customerId` only when roles include `CUSTOMER`.
- **API**: `ChangeUserRolesDto`, `ChangeUserRolesCommand`, `ChangeUserRolesService`; controller maps
  `UserNotFound`→404, `CannotRemoveOwnAdmin`/`LastActiveAdmin`→409, `UserValidation`→400; returns
  the `GET /users/{id}` shape. Swagger + JSDoc.
- **Docs**: constitution III PATCH, ADR `0010-role-changes-...` (indexed), README endpoint table.

## Project Structure

```text
src/domain/{user.aggregate.ts,last-active-admin-policy.ts,audit/*,errors/cannot-remove-own-admin.error.ts}
src/repositories/user.repository.ts          # AdminTx.saveRoles
src/commands/change-user-roles.command.ts
src/services/change-user-roles.service.ts
src/dto/change-user-roles.dto.ts
src/controllers/users.controller.ts
src/infra/security/jose-token-issuer.ts
test/{unit,integration,component}/...
```

## Complexity Tracking

None.

# Implementation Plan: Enable or disable a user (US-07)

**Branch**: `feature/US-07-enable-disable-user` | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-enable-disable-user/spec.md`

## Summary

`PATCH /users/{id}/status` (`@Roles(ADMIN)`, `ParseUUIDPipe`, `ChangeUserStatusDto`) dispatches `ChangeUserStatusCommand` to `ChangeUserStatusService` (`@CommandHandler`). In one transaction (`UserRepository.inStatusTransaction`) the handler:

1. takes the status-change advisory lock (R3);
2. re-reads the acting admin, and returns 401 if they are not `ACTIVE` (R5);
3. locks the target `FOR UPDATE`, and returns 404 if it is missing;
4. calls `user.disable(actorId)` / `user.enable()`, which applies the self rule and returns whether anything changed (R1);
5. for an effective disable of an admin, calls `countActiveAdmins` and then `LastActiveAdminPolicy` (R2);
6. calls `saveStatus`, then `revokeAllRefreshTokens` when disabling (R8).

After the commit it logs the change and returns the US-06 `UserSummaryReadModel`.

Two existing flows get race fixes so that no refresh token of a disabled user survives (R6 refresh `FOR SHARE`, R7 conditional `lastLoginAt` update). Nothing needs a migration and no new package is added. Decisions are in [research.md](research.md); the contract is in [contracts/user-status.md](contracts/user-status.md).

**Deviation from the input:** the input asked to lock the target row first and then the active admins in id order. Crossed disables would deadlock that way and end in a 500, so a single advisory lock is taken first instead (R3).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `@nestjs/cqrs`, `@nestjs/swagger`, `class-validator`, TypeORM 0.3. No new packages.

**Storage**: PostgreSQL `users`, `refresh_tokens`. No migration.

**Testing**: Jest, Supertest, testcontainers (PostgreSQL; Kafka on a closed port)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: no new target. The operation is a single short transaction, and revocation uses the `userId` index.

**Constraints**:
- At least one `ACTIVE` admin under any concurrency.
- No refresh token of a disabled user stays usable.
- No secrets in logs.
- Works with Kafka down.

**Scale/Scope**: 1 endpoint, 1 command handler, 2 aggregate methods, 1 policy, 2 errors, 1 transaction port, 2 small fixes to existing flows, 1 ADR.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. DDD layering | ✅ | The self rule is on `User` and the last-admin rule is in `LastActiveAdminPolicy`. The handler orchestrates, the repository persists (narrow `saveStatus`), and the controller maps errors to 404/409. |
| II. Security | ✅ | Disable revokes every refresh token atomically. Login and refresh refuse with the generic 401. The acting admin is re-checked. Logs carry ids only. |
| III. Authorization & roles | ✅ | `PATCH /users/{id}/status` is `ADMIN`, as in the constitution table. No role is changed (FR-015). Access tokens expire naturally, as the constitution states. |
| IV. Write flow | ✅ | PostgreSQL commit only; no event (spec out of scope). |
| V. Types & validation | ✅ | Enum DTO with `forbidNonWhitelisted`, `ParseUUIDPipe`, typed errors, no `any`. |
| VI/VII. Tests | ✅ | Unit, integration and component suites, listed below. |
| VIII. Kafka | ✅ | Nothing is published; a component test runs with Kafka unreachable. |
| IX. Branching | ✅ | `feature/US-07-enable-disable-user`. |
| X. Quality gate | ✅ | The gate runs after every task. |

Post-design re-check: there are no violations.

## Project Structure

### Documentation (this feature)

```text
specs/007-enable-disable-user/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/user-status.md
```

### Source Code (new or changed)

```text
src/
├── domain/user.aggregate.ts                      # + disable, enable, isActiveAdmin (R1)
├── domain/last-active-admin-policy.ts            # R2
├── domain/errors/cannot-disable-self.error.ts, last-active-admin.error.ts
├── domain/errors/user-not-found.error.ts         # JSDoc generalized
├── commands/change-user-status.command.ts
├── services/change-user-status.service.ts        # @CommandHandler (R10, R13)
├── repositories/user.repository.ts               # + inStatusTransaction / UserStatusTx (R9)
├── repositories/refresh-token.repository.ts      # + lockUserForShare (R6); saveWithLogin guard (R7)
├── services/refresh.service.ts                   # call lockUserForShare (R6)
├── dto/change-user-status.dto.ts                 # R12
├── controllers/users.controller.ts               # + PATCH :id/status, 404/409 mapping (R11)
├── app.module.ts                                 # + handler
└── README.md                                     # module README
README.md, docs/adr/0006-*.md, docs/adr/README.md
```

**Structure Decision**: single project, following the US-04 transaction-port pattern and the US-05/06 command/query handlers.

### Tests

**Unit**

- `User.disable`/`enable`: change, no-op, self-disable (it wins even when the user is already disabled), `updatedAt`, other fields untouched.
- `LastActiveAdminPolicy`: count 1 or 0 → error; count ≥2 → ok; non-admin or disabled target → ok.
- `ChangeUserStatusService` (with a mocked tx):
  - disable revokes tokens and logs once;
  - enable does not revoke;
  - an idempotent request writes nothing and logs nothing;
  - self → `CannotDisableSelfError`, with the self error winning over last-admin;
  - last admin → `LastActiveAdminError`;
  - unknown target → `UserNotFoundError`;
  - actor missing or disabled → `InvalidAccessTokenError`;
  - the call order is lock → actor → target;
  - the log contains no email.
- `ChangeUserStatusDto`: valid values; missing, wrong-case, non-string and extra fields are rejected.
- `UsersController`: 404 and 409 mapping.
- `LoginService`/`RefreshService`: updated for the new calls.

**Integration (PostgreSQL)**

- `revokeAllRefreshTokens`: revokes all families and leaves already-revoked rows unchanged.
- `saveStatus` writes only `status`/`updatedAt`; `countActiveAdmins`.
- Advisory lock: a second transaction blocks until the first commits.
- A crossed disable of two admins leaves exactly one `ACTIVE`, with no deadlock.
- A refresh in flight vs a disable: the successor is revoked or the refresh is refused.
- `saveWithLogin` on a disabled user inserts no token.

**Component**

- After a disable: login, old refresh and `/users/me` → 401.
- After an enable: login works and the old refresh token → 401.
- Self-disable → 409; the only active admin cannot be disabled (409); with a second admin, B can disable A.
- Concurrent crossed disables → exactly one `ACTIVE` admin, the other request gets 401.
- A disabled admin's still-valid token on PATCH → 401.
- Customer → 403; no token → 401; invalid status, unknown field or bad id → 400; unknown id → 404.
- Idempotent → 200 with no change.
- Works with Kafka down; captured logs contain no email or token.

### Docs to update

- **README**:
  - add the `PATCH /users/{id}/status` endpoint section (body, responses, safeguards);
  - add a row to the Access control table;
  - extend Session trade-offs: a disabled user's access tokens stay valid on token-only routes until `exp` (≤ `JWT_ACCESS_TTL_SECONDS`), while `/users/me`, login, refresh and this endpoint refuse at once.
- **`src/README.md`**: add the status flow and the lock order.
- **ADR 0006** (R15) and the ADR index.

## Complexity Tracking

None.

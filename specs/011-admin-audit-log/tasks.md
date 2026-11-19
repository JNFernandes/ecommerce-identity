# Tasks: Audit log of administrative actions (US-11)

**Input**: `specs/011-admin-audit-log/` (spec.md, plan.md)
**Tests**: included (constitution VI/VII; every task ends with a green quality gate and a commit).

Already in place (verify, don't rebuild): `audit_records` table + append-only trigger
(`tests/integration/audit-records-migration.integration.spec.ts`), `USER_STATUS_CHANGED` write and
rollback in `ChangeUserStatusService` (`tests/integration/status-change-audit.integration.spec.ts`).

## Phase 1: Setup

None (no new dependency or config).

## Phase 2: Foundational (read path, blocks every story)

- [X] T001 Add migration `src/infra/database/migrations/<ts>-AddAuditRecordIndexes.ts` (timestamp after `20261119120000`) creating `("occurredAt" DESC, id DESC)`, `("actorId", "occurredAt" DESC, id DESC)`, `("targetId", "occurredAt" DESC, id DESC)` on `audit_records` with a reversible `down`; register it where `20261118120000-AddUserListIndexes` is registered; assert the three indexes exist in `tests/integration/audit-records-migration.integration.spec.ts`. Commit `feat(US-11): add audit record indexes`.
- [X] T002 Add `ListAuditRecordsQuery(actingAdminId, limit, offset, actorId?, targetId?, action?: AuditAction)` in `src/queries/list-audit-records.query.ts` and `AuditRecordReadModel` (`id, actorId, action, targetId, before, after, createdAt`) + `AuditPageReadModel` (`items, total, limit, offset`) in `src/queries/audit-record.read-model.ts`, mirroring `list-users.query.ts` / `user-summary.read-model.ts`, with JSDoc.
- [X] T003 Add read-only `AuditRecordRepository.findPage(query)` in `src/repositories/audit-record.repository.ts` (no update/delete methods): AND filters on `actorId`/`targetId`/`action`, `ORDER BY "occurredAt" DESC, id DESC`, `skip/take`, `getManyAndCount`, explicit entity → read model mapping (`createdAt` ← `occurredAt`), mirroring `UserRepository.findPage`; register as provider in `src/app.module.ts`; integration test in `tests/integration/audit-record-repository.integration.spec.ts` (ordering with equal `occurredAt`, each filter, combined filters, offset past end, total). Commit with T002 as `feat(US-11): add audit record read repository`.
- [ ] T004 Add `ListAuditRecordsService` (`@QueryHandler(ListAuditRecordsQuery)`) in `src/services/list-audit-records.service.ts`: re-read caller via `UserRepository.findById`; missing or not `isActiveAdmin()` → `InvalidAccessTokenError(USER_UNAVAILABLE)`; else `AuditRecordRepository.findPage`; no logging of records; register in `src/app.module.ts`; unit test `tests/unit/services/list-audit-records.service.spec.ts`. Commit `feat(US-11): add ListAuditRecordsService`.
- [ ] T005 Add `ListAuditRecordsQueryDto` in `src/dto/list-audit-records-query.dto.ts` (`limit` int 1–100 default 20, `offset` int ≥0 default 0 — reuse bounds from `src/dto/list-users-query.dto.ts`; `actorId`/`targetId` `@IsUUID`; `action` `@IsEnum(AuditAction)`; arrays from repeated params rejected), `AuditRecordResponseDto` in `src/dto/audit-record-response.dto.ts` and `AuditPageResponseDto` in `src/dto/audit-page-response.dto.ts` with Swagger + JSDoc; unit test `tests/unit/dto/list-audit-records-query.dto.spec.ts` (defaults, 0/101/-1/1.5, bad uuid, unknown action, repeated param).
- [ ] T006 Add `AuditController` in `src/controllers/audit.controller.ts` (`@Controller('audit')`, `@Get()`, `@Roles(Role.ADMIN)`, Swagger 200/400/401/403, caller id from the token as in `users.controller.ts`, `queryBus.execute(new ListAuditRecordsQuery(...))`); register in `src/app.module.ts`. Commit with T005 as `feat(US-11): add GET /audit endpoint`.

**Checkpoint**: `GET /audit` works end-to-end; stories below verify it at component level.

## Phase 3: User Story 1 - Read the audit trail (P1) 🎯 MVP

**Independent test**: seeded admin creates a user and changes their roles; `GET /audit` shows both, newest first, with page metadata.

- [ ] T007 [P] [US1] Component test `tests/component/audit-list.component.spec.ts`: defaults (`limit` 20, `offset` 0, `total`), newest-first order, exact item keys (no password/hash/token/email), paging through all pages returns each record once, offset past end → empty `items` + real `total`, no records → `total` 0. Commit `test(US-11): add component tests for audit listing`.

## Phase 4: User Story 2 - Filter the trail (P1)

**Independent test**: two admins act on two users with different actions; each filter alone and combined.

- [ ] T008 [P] [US2] Component test `tests/component/audit-list-filters.component.spec.ts`: `actorId`, `targetId`, `action` alone and combined (AND), `total` counts only matches, well-formed unknown id → 200 empty. Commit `test(US-11): add component tests for audit filters`.

## Phase 5: User Story 3 - Status changes are audited (P1)

**Independent test**: disable then enable a user; repeat a no-op; read `GET /audit?targetId=…`.

- [ ] T009 [P] [US3] Component test `tests/component/audit-status-change.component.spec.ts`: disable → one `USER_STATUS_CHANGED` record (`before {status: ACTIVE}`, `after {status: DISABLED}`, actor, target); enable → second record; no-op → no new record (rollback on audit failure stays covered by `status-change-audit.integration.spec.ts`). Commit `test(US-11): verify status changes in the audit trail`.

## Phase 6: User Story 4 - Records cannot be altered (P2)

**Independent test**: UPDATE/DELETE as the app's DB user fail; INSERT still works.

- [ ] T010 [US4] Verify only: confirm `audit-records-migration.integration.spec.ts` covers UPDATE/DELETE rejection and INSERT success (add the missing assertion if any) and that `AuditRecordRepository` exposes no write methods. No commit if nothing changed.

## Phase 7: User Story 5 - Access and validation (P2)

**Independent test**: no token, customer token, disabled/demoted admin token, invalid query params.

- [ ] T011 [P] [US5] Component test `tests/component/audit-list-access.component.spec.ts`: no token 401, customer 403, disabled and demoted admin → generic 401; 400 (never 500) for `limit` 0/101/-1/1.5, `offset` -1/1.5, bad `actorId`/`targetId`, unknown `action`, unknown param, repeated `action`; `limit=100` → 200. Commit `test(US-11): add access and validation tests for GET /audit`.

## Phase 8: Polish

- [ ] T012 Docs: `README.md` (`GET /audit` row without "planned", audited actions `USER_CREATED`/`ROLES_CHANGED`/`USER_STATUS_CHANGED`, append-only trigger note), `src/README.md` (audit read path: controller → `ListAuditRecordsService` → `AuditRecordRepository.findPage`), `.specify/memory/constitution.md` XI migration note on US-07 → resolved (PATCH version bump + sync report). Commit `docs(US-11): document GET /audit and resolve constitution XI note`.

## Dependencies

- T001 → T003 (indexes before repo test); T002 → T003 → T004 → T006; T005 → T006.
- T007–T011 depend on T006 only and are independent of each other (different files).
- T012 last.

## Parallel examples

- After T006: T007, T008, T009, T011 in parallel (separate spec files).
- T001 and T002 can run in parallel; T005 in parallel with T003/T004.

## Implementation strategy

MVP = Phase 2 + US1 (T001–T007): admins can read the trail. Then US2/US3 (P1 verification), US4/US5 (P2), docs. Run the quality gate after each task; commit per task (or per pair where noted).

# Tasks: An administrator assigns and revokes roles (US-10)

**Input**: [spec.md](spec.md), [plan.md](plan.md). Each task ends with the quality gate and a
Conventional Commit (`feat(US-10): ...`, `test(US-10): ...`, `docs(US-10): ...`).

Stories: US1 promote, US2 revoke, US3 first `CUSTOMER` grant, US4 safeguards, US5 validation/access/audit.
All stories share one endpoint, so tasks are layered (domain → persistence → service → endpoint →
tests → docs) rather than one phase per story; labels show which stories each task serves.

## Phase 1: Domain

- [X] T001 [US1] [US2] [US3] [US4] Add `User.changeRoles(roles, actorId)` returning `{ changed, removed, customerCreated }` (no-op on equal sets, checked first; throws new `CannotRemoveOwnAdminError` 409; first `CUSTOMER` grant without `customerId` creates one ≠ id and records `UserRegistered`; removing `CUSTOMER` keeps `customerId`) in `src/domain/user.aggregate.ts` and `src/domain/errors/cannot-remove-own-admin.error.ts`; add `LastActiveAdminPolicy.assertCanRemoveAdmin({ target, activeAdminCount })` reusing `LastActiveAdminError` in `src/domain/last-active-admin-policy.ts`; add `AuditAction.ROLES_CHANGED` and `AuditRecord.rolesChanged(actor, user, before, now)` in `src/domain/audit/`; unit tests in `test/unit/`.

## Phase 2: Persistence

- [X] T002 [US1] [US3] [US5] Add `AdminTx.saveRoles(user)` (roles + `customerId`) in `src/repositories/user.repository.ts`; add a migration in `src/migrations/` only if the audit `action` column is a DB enum/check; integration test in `test/integration/`.

## Phase 3: Service, token and endpoint

- [X] T003 [US1] [US2] [US3] [US4] [US5] Create `ChangeUserRolesCommand` in `src/commands/change-user-roles.command.ts` and `ChangeUserRolesService` in `src/services/change-user-roles.service.ts`: in one `AdminTx` take the shared `lockAdminChanges` advisory lock → re-read actor (generic 401 if missing/not `ACTIVE`/not `ADMIN`) → `findByIdForUpdate` target (404) → `changeRoles` → if `ADMIN` removed, `countActiveAdmins` + policy → `saveRoles` → `revokeAllRefreshTokens` if any role removed → `appendAudit`; after commit dispatch `UserRegistered` via `UserEventDispatcher` (dead-letter fallback); log actor, target, before/after roles once. In `src/infra/security/jose-token-issuer.ts` put `customerId` in tokens only when roles include `CUSTOMER` (FR-008a).
- [X] T004 [US5] Create `ChangeUserRolesDto` (`@ArrayNotEmpty`, `@ArrayUnique`, `@IsEnum(Role, { each: true })`, Swagger) in `src/dto/change-user-roles.dto.ts`; add `PUT /users/:id/roles` (`@Roles(ADMIN)`, Swagger, JSDoc) to `src/controllers/users.controller.ts` mapping `UserNotFound`→404, `CannotRemoveOwnAdmin`/`LastActiveAdmin`→409, `UserValidation`→400, returning the `GET /users/{id}` shape; register the service in the users module.

## Phase 4: Component tests

- [ ] T005 [US1] [US2] [US3] [US4] [US5] Add `test/component/change-user-roles.component.spec.ts`: promote then login gets `ADMIN`; grant keeps sessions; demote revokes refresh tokens; removing `CUSTOMER` keeps `customerId`, no event, no `customerId` in new token; first `CUSTOMER` grant publishes one event, re-grant none, Kafka down → 200 + dead-letter; self-demotion and last-active-admin 409; concurrent mutual demotion leaves ≥1 `ACTIVE` admin; 400 (empty, unknown, repeated, missing, extra), 404, 401/403, demoted-actor 401; no-op 200 with no audit; one `ROLES_CHANGED` audit per change.

## Phase 5: Docs

- [ ] T006 [P] Amend constitution III (PATCH, settles `TODO(ROLE_CHANGE_CUSTOMER_ID)`) in `.specify/memory/constitution.md`; add `docs/adr/0010-role-changes.md` and index it in `docs/adr/README.md`; add the endpoint and token trade-off note to `README.md`.

## Dependencies

T001 → T002 → T003 → T004 → T005; T006 is independent ([P] with any task after T001). MVP = T001–T004
(US1 + US2 + US4); T005 verifies all stories.

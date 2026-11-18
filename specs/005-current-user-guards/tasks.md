---
description: "Task list for US-05: Current user endpoint and role-based access guards"
---

# Tasks: Current user endpoint and role-based access guards (US-05)

**Input**: `specs/005-current-user-guards/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Requested (plan "Tests", constitution VI/VII). Each task ships its own tests in the same commit, so the gate stays green.

**Story labels**: `[US1]`–`[US5]` are the spec's stories (current user / reject untrusted tokens / roles / default deny / Swagger). All commits use the repo story scope `US-05`.

**Scope notes**:
- No migration and no new package. No Kafka event.
- Every authentication failure is one `InvalidAccessTokenError` (R6), mapped only by `AccessTokenExceptionFilter` to the byte-identical 401 (R7). Role mismatch → `ForbiddenException('forbidden')`.
- Registering the global `JwtAuthGuard` (T008) makes every route protected, so the existing controllers get `@Public` in the same task.

## Definition of done (every task)

1. Write the tests named in the task first, then the code.
2. Run the quality gate: `npm run build --silent && npm run lint --silent && npm run format:check --silent -- --log-level warn && npm run test --silent -- --silent` (component and integration tests need Docker).
3. Green gate → commit with the message given in the task (Conventional Commits, `Co-Authored-By` trailer) and tick the box.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- Paths are relative to the repo root (single project: `src/`, `tests/`)

---

## Phase 1: Setup (configuration)

- [X] T001 Add `jwt.clockToleranceSeconds` (`JWT_CLOCK_TOLERANCE_SECONDS`, default 5, parsed with `parseNonNegativeInteger`) with JSDoc to `JwtConfig` in `src/config/configuration.ts` (R15). Extend `tests/unit/config/configuration.spec.ts`: default 5, override, `0` accepted, negative and non-numeric rejected. Commit `feat(US-05): add the JWT clock tolerance setting`.

---

## Phase 2: Foundational (domain, verifier, decorators, authentication guard)

**Purpose**: Everything a protected route needs. Blocks every story. Ends with default deny active and every existing route `@Public`.

- [X] T002 [P] Create the `AccessTokenFailureReason` enum (the 11 reasons in data-model.md) and `InvalidAccessTokenError` (fixed message `unauthorized`, readonly `reason`, JSDoc) in `src/domain/errors/invalid-access-token.error.ts` (R6). Extend `tests/unit/domain/errors.spec.ts`: name, message identical for every reason, `reason` kept, `instanceof Error`. Commit `feat(US-05): add InvalidAccessTokenError`.
- [X] T003 Create the immutable `AuthenticatedPrincipal` value object (`userId`, `roles: readonly Role[]` de-duplicated, `customerId: string | null`, `hasAnyRole(allowed)`, `static fromClaims(claims: unknown)` throwing `InvalidAccessTokenError(INVALID_CLAIMS)`) with JSDoc in `src/domain/authenticated-principal.ts` (R5; depends on T002). Tests in `tests/unit/domain/authenticated-principal.spec.ts`: valid customer, admin without `customerId` → `null`, duplicate roles removed; rejects non-object claims, missing/empty `sub`, missing/empty/non-array/unknown roles, non-string or empty `customerId`; `hasAnyRole` true on overlap, false otherwise. Commit `feat(US-05): add AuthenticatedPrincipal`.
- [X] T004 Create the `AccessTokenVerifier` abstract class (`verify(token: string): Promise<AuthenticatedPrincipal>`, JSDoc) in `src/services/ports/access-token-verifier.ts` (R1), and `JoseAccessTokenVerifier` in `src/infra/auth/jose-access-token-verifier.ts` (R2–R4): constructor takes the `KeyRing` public JWKs plus `{ issuer, audience, clockToleranceSeconds }` and a `Clock`; a static async `create(...)` imports every JWK (active + retired) once into `Map<kid, KeyLike>`; `verify` calls `jwtVerify` with a `kid` resolver, `algorithms: ['RS256']`, `issuer`, `audience`, `clockTolerance`, `requiredClaims: ['sub','iat','exp','jti']`, then rejects `iat > now + tolerance`, then `AuthenticatedPrincipal.fromClaims`. Every jose error is wrapped in `InvalidAccessTokenError` with the matching reason (`MALFORMED_TOKEN`, `UNSUPPORTED_ALGORITHM`, `UNKNOWN_KEY`, `INVALID_SIGNATURE`, `EXPIRED`, `NOT_YET_VALID`, `CLAIM_MISMATCH`, `INVALID_CLAIMS`); no network or file access per call. Tests in `tests/unit/infra/jose-access-token-verifier.spec.ts` (keys generated in the test, real `jose` signing): every case in the plan's verifier list (valid, expired beyond/within tolerance, tampered, `alg: none`, HS256 signed with the public key PEM, wrong `iss`, wrong `aud`, missing `kid`, unknown `kid`, retired key accepted, future `iat` beyond tolerance, missing `jti`), each failure an `InvalidAccessTokenError` whose message and reason never contain the token. Commit `feat(US-05): verify access tokens locally with jose`.
- [X] T005 [P] Create the route decorators in `src/controllers/auth/`: `public.decorator.ts` (`IS_PUBLIC_KEY`, `Public()`), `roles.decorator.ts` (`ROLES_KEY`, `Roles(...roles: Role[])`, metadata only for now; Swagger added in T018), `authenticated-request.ts` (`AuthenticatedRequest` extends Express `Request` with `principal: AuthenticatedPrincipal`), `current-user.decorator.ts` (`createParamDecorator` returning `request.principal`) (R10), all with JSDoc. Tests in `tests/unit/controllers/auth/decorators.spec.ts`: metadata on handler and class, `CurrentUser` factory returns the request principal. Commit `feat(US-05): add Public, Roles and CurrentUser decorators`.
- [X] T006 [P] Create `AccessTokenExceptionFilter` (`@Catch(InvalidAccessTokenError)`) in `src/controllers/auth/access-token-exception.filter.ts`: logs `reason` at `warn` (no token, no header), responds 401 with header `WWW-Authenticate: Bearer` and body `{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}` (R7; depends on T002). Tests in `tests/unit/controllers/auth/access-token-exception.filter.spec.ts`: exact status, header and body, identical for two different reasons, log line has the reason but not the token. Commit `feat(US-05): map InvalidAccessTokenError to a generic 401`.
- [X] T007 Create `JwtAuthGuard` (`CanActivate`) in `src/controllers/auth/jwt-auth.guard.ts`: skips handlers/classes with `IS_PUBLIC_KEY` (`Reflector.getAllAndOverride`) without reading the header; otherwise requires `Authorization` to match `/^Bearer ([^\s]+)$/i` (`MISSING_HEADER` / `MALFORMED_HEADER`), calls `AccessTokenVerifier.verify` and sets `request.principal` (R8–R10; depends on T004, T005). Tests in `tests/unit/controllers/auth/jwt-auth.guard.spec.ts`: public route skips the verifier even with an invalid header; missing, `Basic`, `Bearer` with empty value, extra spaces, two tokens each throw `InvalidAccessTokenError`; lower-case `bearer` accepted; principal attached; verifier errors propagate unchanged. Commit `feat(US-05): add the global JWT authentication guard`.
- [X] T008 Wire default deny in `src/app.module.ts`: provide `AccessTokenVerifier` via an async factory calling `JoseAccessTokenVerifier.create` with the existing `KeyRing`, `jwt.issuer`, `jwt.audience`, `jwt.clockToleranceSeconds` and `Clock`; register `JwtAuthGuard` as `APP_GUARD` and `AccessTokenExceptionFilter` as `APP_FILTER`. In the same commit add class-level `@Public()` to `src/controllers/auth.controller.ts`, `src/controllers/jwks.controller.ts` and `src/controllers/health.controller.ts` (FR-012). All existing unit and component tests must stay green. Commit `feat(US-05): enable default deny with public existing routes`.

**Checkpoint**: Default deny is active; every existing route is public and unchanged.

---

## Phase 3: User Story 1 - See my own account (Priority: P1) 🎯 MVP

**Goal**: `GET /users/me` returns the stored account of the token's user.

**Independent Test**: Register and log in, call `GET /users/me`, compare with the stored user; repeat for an admin.

- [X] T009 [P] [US1] Create `CurrentUserResponseDto` (fields and Swagger per data-model.md; `customerId` optional and omitted from the JSON when null; `static from(readModel)`; `createdAt` as ISO string) with JSDoc in `src/dto/current-user-response.dto.ts`. Tests in `tests/unit/dto/current-user-response.dto.spec.ts`: customer has all 7 fields, admin JSON has no `customerId` key, no other keys. Commit `feat(US-05): add CurrentUserResponseDto`.
- [X] T010 [US1] Create `GetCurrentUserQuery(userId)` in `src/queries/get-current-user.query.ts` and `GetCurrentUserService` (`@QueryHandler`, `CurrentUserReadModel` type) in `src/services/get-current-user.service.ts`: `UserRepository.findById`, missing or `!canLogin()` → `InvalidAccessTokenError(USER_UNAVAILABLE)`, otherwise map `id, customerId, email, name, roles, status, createdAt` (R14; depends on T002). Tests in `tests/unit/services/get-current-user.service.spec.ts`: active customer read model (no hash, `updatedAt`, `lastLoginAt`), admin with `customerId: null`, missing user and `DISABLED` user throw `USER_UNAVAILABLE`, a repository error propagates unchanged (5xx, never 401). Commit `feat(US-05): add the GetCurrentUser query handler`.
- [ ] T011 [US1] Create `UsersController` (`@Controller('users')`, `@Get('me')`, `@Roles(Role.CUSTOMER, Role.ADMIN)`, `@CurrentUser()` principal → `QueryBus.execute(new GetCurrentUserQuery(principal.userId))` → `CurrentUserResponseDto.from`, `@ApiOkResponse`, JSDoc) in `src/controllers/users.controller.ts`; register the controller and `GetCurrentUserService` in `src/app.module.ts` (depends on T008, T009, T010). Tests in `tests/unit/controllers/users.controller.spec.ts`: dispatches the query with the principal's `userId` and returns the DTO. Commit `feat(US-05): add GET /users/me`.
- [ ] T012 [US1] Add `insertAdminAndLogin(app)` (inserts an `ADMIN` `User` through `UserRepository`, logs in normally; R16) to `tests/component/support/token-flow.ts`, and write `tests/component/users-me.component.spec.ts`: customer → 200 with exactly the contract fields matching the stored row and no password/hash/token; admin → 200 without `customerId`; user disabled after login → 401; user deleted after login → 401 (same body and `WWW-Authenticate: Bearer`). Commit `test(US-05): cover GET /users/me end to end`.

**Checkpoint**: MVP — a logged-in user can read their own account.

---

## Phase 4: User Story 2 - Reject requests without a trustworthy token (Priority: P1)

**Goal**: Only valid RS256 tokens from this service are accepted; every other request gets the identical 401.

**Independent Test**: Send each forged, downgraded, expired or malformed token to `GET /users/me` and compare the responses.

- [ ] T013 [US2] Component test `tests/component/access-control.component.spec.ts` (tokens forged in the test with `jose` and the test key pair from `tests/component/support/test-app.ts`): no header, `Basic`, empty Bearer, extra spaces, two tokens, non-JWT value, refresh token as Bearer, `alg: none`, HS256 HMAC-signed with the public key PEM, unknown `kid`, missing `kid`, tampered payload, wrong `iss`, wrong `aud`, `exp` beyond the tolerance, missing `jti`, unknown role → all 401 with `WWW-Authenticate: Bearer` and byte-identical bodies that never contain the token; accepted: lower-case `bearer`, `exp` within the tolerance, a token signed by a retired key published via `useRetiredPublicKeys` (US2-AS5/AS6). Commit `test(US-05): cover the access token rejection matrix`.

---

## Phase 5: User Story 3 - Restrict routes by role (Priority: P1)

**Goal**: `@Roles` enforces 403 after authentication.

**Independent Test**: Test-only `ADMIN` route: customer → 403, admin → 200; `/users/me` → 200 for both.

- [ ] T014 [US3] Create `RolesGuard` in `src/controllers/auth/roles.guard.ts`: public routes pass; otherwise reads `ROLES_KEY` (`getAllAndOverride`) and throws `ForbiddenException('forbidden')` unless `request.principal.hasAnyRole(roles)` (R7, R8). Register it as the second `APP_GUARD` (after `JwtAuthGuard`) in `src/app.module.ts`. Tests in `tests/unit/controllers/auth/roles.guard.spec.ts`: public passes, matching role passes, mismatch throws 403 with body `{"statusCode":403,"message":"forbidden","error":"Forbidden"}`. Commit `feat(US-05): enforce route roles with RolesGuard`.
- [ ] T015 [US3] Create the test-only `AdminProbeController` (`GET /test/admin-probe`, `@Roles(Role.ADMIN)`, returns `{ userId, roles }` from `@CurrentUser()`) in `tests/component/support/admin-probe.controller.ts` (R17); add an `extraControllers` option to `createTestApp` in `tests/component/support/test-app.ts`. Component test `tests/component/roles.component.spec.ts`: customer → 403 generic body, admin → 200 with its own `userId`/`roles` (handler gets the principal), no token and invalid token → 401 (not 403), customer and admin both → 200 on `/users/me`. Commit `test(US-05): cover role restriction with a test-only admin route`.

---

## Phase 6: User Story 4 - Default deny for every route (Priority: P2)

**Goal**: An undeclared route stops the service at startup; public routes are unaffected by tokens.

**Independent Test**: The app starts; a test module with an undeclared route fails `init()` naming it; public endpoints work without a token.

- [ ] T016 [US4] Create `findRoutePolicyViolations(controllers, reflector, metadataScanner)` and `RoutePolicyCheck implements OnApplicationBootstrap` (uses `DiscoveryService`; throws `route policy violation: <Controller>.<handler> (<METHOD> <path>), …` for handlers with neither decorator, both, or empty `@Roles()`) in `src/controllers/auth/route-policy.check.ts` (R12); import `DiscoveryModule` and register the check in `src/app.module.ts`. Tests in `tests/unit/controllers/auth/route-policy.check.spec.ts`: every `AppModule` controller has no violation; undeclared, both-decorated and empty-roles handlers are each named; a `Test.createTestingModule` with an undeclared controller rejects `init()` with the route in the message. Commit `feat(US-05): fail startup on routes without an access policy`.
- [ ] T017 [US4] Component test `tests/component/public-routes.component.spec.ts`: register, login, refresh, logout, `GET`/`HEAD /.well-known/jwks.json`, `/health`, `/docs` and `/docs-json` respond as before with no `Authorization` header and with `Authorization: Bearer invalid` (US4-AS2/AS3, R13). Commit `test(US-05): cover public routes with and without tokens`.

---

## Phase 7: User Story 5 - Discover authentication in the API documentation (Priority: P3)

**Goal**: Swagger shows the bearer scheme and roles per protected route.

**Independent Test**: Read `/docs-json` and check security, `x-roles`, 401 and 403 on `/users/me`.

- [ ] T018 [US5] Extend `Roles(...)` in `src/controllers/auth/roles.decorator.ts` with `applyDecorators` adding `ApiBearerAuth()`, `ApiUnauthorizedResponse`, `ApiForbiddenResponse` and `ApiExtension('x-roles', roles)` (R11); confirm `addBearerAuth()` in `src/app.swagger.ts`. Component test `tests/component/swagger-auth.component.spec.ts` on `/docs-json`: a bearer scheme exists, `GET /users/me` has `security` with it, `x-roles: ["CUSTOMER","ADMIN"]`, 401 and 403 responses; register, login and health have no `security`. Commit `feat(US-05): document bearer auth and roles in Swagger`.

---

## Phase 8: Polish & cross-cutting

- [ ] T019 [P] Component test `tests/component/users-me-kafka-unavailable.component.spec.ts`: with `useUnreachableKafka()`, a seeded user logs in and `GET /users/me` returns 200 (FR-015, SC-007). Commit `test(US-05): cover GET /users/me with Kafka unreachable`.
- [ ] T020 [P] Component test `tests/component/access-control-logging.component.spec.ts` using `tests/component/support/capturing-logger.ts`: run 200, 401 (several reasons) and 403 flows; no captured line or error body contains an access token, a refresh token or an `Authorization` value, and a `warn` line carries the failure reason (FR-013, SC-006). Commit `test(US-05): assert no tokens in access control logs`.
- [ ] T021 [P] Update `README.md`: calling protected routes with `Authorization: Bearer`, the access control model (route table, 401 vs 403), default deny (`@Public` or `@Roles` required, startup fails otherwise), `GET /users/me`, `JWT_CLOCK_TOLERANCE_SECONDS` in the configuration table, roles section from "planned" to current. Commit `docs(US-05): document access control and GET /users/me`.
- [ ] T022 [P] Add `JWT_CLOCK_TOLERANCE_SECONDS=5` with a comment to `.env.example` (FR-006). Commit `docs(US-05): add the clock tolerance setting to .env.example`.
- [ ] T023 [P] Write `docs/adr/0005-default-deny-route-guards.md` from `docs/adr/template.md` (local verification over the key ring, global guards with default deny and the startup check, no `jti` blacklist; rejected: per-route `@UseGuards`, public path list) and index it in `docs/adr/README.md` (R18). Commit `docs(US-05): add ADR 0005 default deny route guards`.
- [ ] T024 [P] Update `src/README.md` with `GET /users/me`, `GetCurrentUserService`, the guards, filter, decorators, `RoutePolicyCheck` and `JoseAccessTokenVerifier`. Commit `docs(US-05): list guards and GET /users/me in the module README`.
- [ ] T025 Run `specs/005-current-user-guards/quickstart.md` manually against `npm run start:dev` and record the results (date, pass/fail per step) at the end of the quickstart. Commit `docs(US-05): record the manual quickstart run`.

---

## Dependencies & execution order

- **Setup (T001)** → **Foundational (T002–T008)** → stories.
- Inside Foundational: T002 → T003 → T004; T002 → T006; T004 + T005 → T007; T001 + T004 + T006 + T007 → T008.
- **US1 (T009–T012)** depends on Foundational; T009, T010 → T011 → T012. MVP.
- **US2 (T013)** depends on T011 (uses `/users/me` as the protected route).
- **US3 (T014–T015)** depends on T011; T014 → T015.
- **US4 (T016–T017)** depends on Foundational; T016 must follow T011 and T014 (it checks every `AppModule` controller and edits `app.module.ts`).
- **US5 (T018)** depends on T011 and T005.
- **Polish** after US5; T019–T024 parallel (different files); T025 last.
- Shared files: `src/app.module.ts` (T008, T011, T014, T016) and `roles.decorator.ts` (T005, T018) — those tasks are sequential.

```text
T001 → T002 → T003 → T004 ─┐
       T002 → T006 ────────┤
       T005 ───────────────┴→ T007 → T008
T008 → {T009, T010} → T011 → T012 (US1 MVP)
                      T011 → T013 (US2)
                      T011 → T014 → T015 (US3)
                      T014 → T016 → T017 (US4)
                      T011 → T018 (US5)
→ Polish T019..T024 [P] → T025
```

## Parallel examples

- Foundational: T002 and T005 together; then T003 and T006 together.
- US1: T009 (DTO) alongside T010 (query handler).
- After T014: T013 (US2 component), T015 (US3 component), T017 (US4 component, after T016) in separate spec files.
- Polish: T019, T020, T021, T022, T023, T024 in parallel.

## Implementation strategy

1. **MVP**: Phases 1–3 (T001–T012) — default deny is on, existing routes are public, `GET /users/me` works.
2. Harden: US2 proves the token rejection matrix; US3 adds 403 enforcement.
3. US4 makes default deny a startup guarantee; US5 documents it in Swagger.
4. Polish (Kafka-down, log hygiene, docs, ADR, quickstart).
5. Gate green and commit after every task; open the PR "Implements US-05: Current user endpoint and role-based access guards" after T025.

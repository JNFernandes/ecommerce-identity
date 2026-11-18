# Research: Seed the first administrator and let admins list users (US-06)

No `NEEDS CLARIFICATION` remained after the clarification session. Each entry gives the decision, then the reason.

## R1. Seed as `AdminSeedService` (`OnApplicationBootstrap`)
`app.init()` runs it after TypeORM has applied migrations and before `listen`, so no request sees a half-seeded state. It lives in `services/` and only orchestrates: config → repository → domain → hasher → repository.

## R2. Seed decision is a domain rule
`AdminSeedPolicy` in `src/domain/` has two methods:
- `precheck({ adminExists, configured })` returns `SKIP_ADMIN_EXISTS`, `SKIP_NOT_CONFIGURED` or `PROCEED`;
- `decide({ emailOwner })` returns `SKIP_EMAIL_TAKEN` or `CREATE`.

The split exists because validation must run after the "configured" check (otherwise an unset variable would be reported as an invalid value) and before the email lookup. All business logic stays in the domain (Principle I). The service acts only on decisions, so it stays a thin, easily tested sequence.

## R3. `User.registerAdmin(email, name, passwordHash)`
Role `ADMIN`, status `ACTIVE`, `customerId: null`, and **no** domain event. With no event, the service has nothing to publish, so FR-008 holds by construction.

## R4. Validation reuses registration rules
`Email.create`, `UserName.create` and `PasswordPolicy.assertAcceptable` throw `UserValidationError`. Their messages never contain the password (existing guarantee). The seed logs the message and skips.

## R5. "Admin exists" via `UserRepository.existsWithRole(Role.ADMIN)`
`SELECT 1 … WHERE 'ADMIN' = ANY(roles) LIMIT 1`, whatever the status. The table is small and there is at most one admin, so no array (GIN) index is needed.

## R6. Concurrent starts
The unique `lower(email)` index already stops a second insert. `save` throws `DuplicateEmailError`, which the seed logs at `warn` before continuing. No advisory lock is needed because every instance reads the same `ADMIN_EMAIL`.

## R7. Failure policy
Configuration problems (missing, invalid or taken email) are logged and startup continues (spec assumption). Database errors propagate and fail startup, so a database outage is never mistaken for "nothing to seed".

## R8. Logging
Messages name the variable and the rule (e.g. `ADMIN_PASSWORD: password must be between 10 and 128 characters`), never a value. On success the seed logs the new user id, not the email or password. A component test scans captured logs for the password.

## R9. Config `admin` block
`configuration.ts` gains `admin: { email, password, name }`. Values are trimmed, and an empty string is treated as unset. `ADMIN_NAME` defaults to `Administrator`. Neither the config object nor the password is ever logged.

## R10. Read side: `@nestjs/cqrs` queries plus a read model
`ListUsersQuery` / `GetUserQuery` are handled by `ListUsersService` / `GetUserService` (`@QueryHandler`), following the US-05 pattern. `UserSummaryReadModel` lives in `queries/` and is neither the aggregate nor the entity. The repository maps entity → read model directly, which avoids rebuilding aggregates for a read-only list.

## R11. Paged query
`UserRepository.findPage(criteria)` uses one query builder:
- `WHERE` clauses for `:role::user_role_enum = ANY(roles)`, `status = :status` and `lower(email) LIKE :prefix ESCAPE '\'`;
- `ORDER BY "createdAt" DESC, id DESC`, then `OFFSET` / `LIMIT`;
- `getManyAndCount` returns the rows and the total (`COUNT` without paging).

The `id` tie-break makes pages stable (US3-AS2).

## R12. Literal email prefix
The filter is lower-cased, then `\`, `%` and `_` are escaped and `%` is appended. Wildcards typed by the user are therefore treated literally (edge case).

## R13. Indexes migration
`AddUserListIndexes20261118120000` adds:
- `IDX_users_created_at_id` on (`"createdAt"` DESC, `id` DESC), for ordered paging;
- `IDX_users_email_lower_prefix` on `lower(email) text_pattern_ops`. The existing unique index uses the default collation, so it cannot serve `LIKE 'x%'`.

Together they keep SC-006 (10k users, under 1 s) far from the limit.

## R14. Query DTO validation
`ListUsersQueryDto`:
- `limit`: `@Type(() => Number) @IsInt @Min(1) @Max(100)`, default 20;
- `offset`: `@IsInt @Min(0)`, default 0;
- `role`: `@IsEnum(Role)`;
- `status`: `@IsEnum(UserStatus)`;
- `email`: `@IsString @MaxLength(254)`; an empty value becomes `undefined`.

The global pipe (`forbidNonWhitelisted`, `transform`) already rejects unknown parameters with 400 and validation details.

## R15. `GET /users/{id}`
`ParseUUIDPipe` returns 400 for a malformed id. `GetUserService` throws the domain `UserNotFoundError`, and the controller maps it to `NotFoundException` (Principle I: map in the controller). `@Get('me')` stays declared before `@Get(':id')`, and `me` is not a UUID anyway.

## R16. Response DTOs
`UserSummaryResponseDto.from(model)` omits `customerId` when it is null and always includes `lastLoginAt` (null allowed). `UserPageResponseDto` holds `items`, `total`, `limit` and `offset`. They are explicit allow-lists, so a hash cannot leak (FR-014).

## R17. Test-only admin probe stays
The US-05 `admin-probe.controller.ts` still tests the guards in isolation. US-06 component tests use the real endpoints and a real seeded admin instead of a hand-inserted row.

## R18. No new ADR
ADR 0003 already decides "admins only from a startup seed". Its follow-up note is closed by this story; README and ADR index links are updated, and no new decision is introduced.

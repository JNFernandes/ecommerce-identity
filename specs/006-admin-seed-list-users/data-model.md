# Data Model: US-06

There are no new tables or columns. One migration adds indexes (R13).

## `User` aggregate (existing, extended)

| Change | Rule |
|---|---|
| `static registerAdmin(email: Email, name: UserName, passwordHash: string): User` | new `id`, `customerId: null`, `roles: [ADMIN]`, `status: ACTIVE`, `createdAt = updatedAt = now`, `lastLoginAt: null`; raises **no** event (R3) |

## `AdminSeedPolicy` (domain, new)

Two methods, both returning `AdminSeedDecision`. The service acts only on the decision and never branches on the raw facts (Principle I).

`precheck({ adminExists: boolean; configured: boolean })`, called before any validation:

1. `adminExists` → `SKIP_ADMIN_EXISTS` (silent, FR-003)
2. `!configured` → `SKIP_NOT_CONFIGURED` (warn, FR-004)
3. otherwise → `PROCEED`

Field validation (`Email`, `UserName`, `PasswordPolicy`) then runs, only after `PROCEED`. This way an unset variable is never reported as a validation error. A failure is `UserValidationError` (error, skip, FR-006).

`decide({ emailOwner: User | null })`, called after the email lookup:

4. `emailOwner !== null` → `SKIP_EMAIL_TAKEN` (error, FR-005; the user is never modified)
5. otherwise → `CREATE`

## `UserNotFoundError` (domain error, new)

Raised by `GetUserService` and mapped to 404 in the controller.

## `AdminSeedConfig` (config, new)

| Field | Env | Rule |
|---|---|---|
| `email` | `ADMIN_EMAIL` | trimmed; empty → `undefined` |
| `password` | `ADMIN_PASSWORD` | never trimmed or logged; empty → `undefined` |
| `name` | `ADMIN_NAME` | trimmed; empty or unset → `Administrator` |

## Read side (`src/queries/`)

| Type | Fields |
|---|---|
| `ListUsersQuery` | `limit: number`, `offset: number`, `role?: Role`, `status?: UserStatus`, `emailPrefix?: string` |
| `GetUserQuery` | `id: string` |
| `UserSummaryReadModel` | `id`, `customerId: string \| null`, `email`, `name`, `roles: Role[]`, `status`, `createdAt: Date`, `lastLoginAt: Date \| null`; no hash, no `updatedAt` |
| `UserPageReadModel` | `items: UserSummaryReadModel[]`, `total`, `limit`, `offset` |

## `UserRepository` (new methods)

| Method | Behaviour |
|---|---|
| `existsWithRole(role)` | `true` if any user holds `role`, whatever their status |
| `findPage(criteria)` | filtered (AND), `createdAt DESC, id DESC`, offset/limit, plus the total of all matching users (R11, R12) |
| `findSummaryById(id)` | `UserSummaryReadModel \| null` |

## Migration `20261118120000-AddUserListIndexes`

- `CREATE INDEX "IDX_users_created_at_id" ON "users" ("createdAt" DESC, "id" DESC)`
- `CREATE INDEX "IDX_users_email_lower_prefix" ON "users" (lower("email") text_pattern_ops)`
- `down` drops both.

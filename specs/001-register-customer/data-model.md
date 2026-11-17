# Data Model: Register a customer account (US-01)

## Domain (`src/domain/`, pure TypeScript)

| Element | Kind | Fields / rules |
|---|---|---|
| `Role` | enum | `CUSTOMER`, `ADMIN` |
| `UserStatus` | enum | `ACTIVE`, `DISABLED` (only `ACTIVE` is used here) |
| `Email` | value object | `create(raw)`: trim, lowercase, at most 254 characters, `local@domain.tld` format, otherwise `UserValidationError` |
| `UserName` | value object | `create(raw)`: trim, 1–100 code points, otherwise `UserValidationError` |
| `PasswordPolicy` | domain rule | `assertAcceptable(password, email)`: 10–128 code points (not trimmed); `password.trim().toLowerCase() !== email.value` |
| `User` | aggregate | `id`, `customerId \| null`, `email: Email`, `name: UserName`, `passwordHash`, `roles: Role[]`, `status`, `createdAt`, `updatedAt` |
| `User.registerCustomer(email, name, passwordHash)` | factory | New UUIDs for `id` and `customerId` (always different), `roles=[CUSTOMER]`, `status=ACTIVE`, timestamps now; records `UserRegistered` |
| `User.restore(props)` | factory | Rebuilds a `User` from persistence; raises no event |
| `UserRegistered` | domain event | `eventId` (UUID), `aggregateId` (= user id), `occurredAt` (ISO 8601), `version` (1), `customerId`, `email`, `name`; JSDoc on every field |
| `UserValidationError` | domain error | maps to 400 |
| `DuplicateEmailError` | domain error | maps to 409 `"email already registered"` |

No state transitions in this story: a user is created `ACTIVE`, and `DISABLED` belongs to a later story.

## Persistence (migration `20261117130000-CreateUsersAndOutboundDeadLetters`)

### `users` (`UserEntity`, mapped explicitly by `UserRepository`)

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `customerId` | uuid | nullable, unique (admins have none) |
| `email` | varchar(254) | not null; **unique index `UQ_users_email_lower` on `lower(email)`** |
| `name` | varchar(100) | not null |
| `passwordHash` | text | not null (argon2id string, `$argon2id$…`) |
| `roles` | `user_role_enum[]` | not null |
| `status` | `user_status_enum` | not null |
| `createdAt` / `updatedAt` | timestamptz | not null |

### `outbound_dead_letters` (`OutboundDeadLetterEntity`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `eventId` | uuid | same id kept on retry |
| `topic` | varchar | `identity.user-registered` |
| `key` | varchar | `aggregateId` |
| `payload` | jsonb | exact event JSON |
| `error` | text | original failure |
| `status` | `outbound_dead_letter_status_enum` | `PENDING_RETRY` (default) / `RESOLVED` / `EXHAUSTED` |
| `retryCount` | int | default 0 |
| `nextRetryAt` | timestamptz | default now() |
| `lastAttemptAt`, `lastError`, `resolvedAt` | nullable | for the US-08 worker |
| `createdAt` | timestamptz | |

Index `(status, nextRetryAt)` so the US-08 worker can claim due rows quickly.

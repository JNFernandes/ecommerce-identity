# Data Model: Log in with email and password (US-02)

## Domain (`src/domain/`, pure TypeScript)

| Element | Kind | Fields / rules |
|---|---|---|
| `Email.normalize(raw)` | static, pure | `raw.trim().toLowerCase()`; used by `Email.create` and by the email throttle tracker |
| `User` | aggregate (changed) | adds `lastLoginAt: Date \| null` (`null` after `registerCustomer`) |
| `User.canLogin()` | rule | `status === ACTIVE` |
| `User.recordLogin(at)` | behaviour | sets `lastLoginAt = at`; throws `InvalidCredentialsError` if `!canLogin()`; `updatedAt` unchanged |
| `RefreshToken` | aggregate (new) | `id`, `userId`, `familyId`, `tokenHash`, `createdAt`, `expiresAt`, `revokedAt \| null`, `replacedBy \| null` |
| `RefreshToken.issue({ userId, tokenHash, issuedAt, ttlSeconds })` | factory | new UUIDs for `id` and `familyId`; `createdAt = issuedAt`; `expiresAt = issuedAt + ttlSeconds`; `revokedAt`/`replacedBy` null; rejects ttl ≤ 0 or an empty hash |
| `RefreshToken.restore(props)` | factory | rebuilds from persistence |
| `InvalidCredentialsError` | domain error | the only credential failure; maps to 401 `"invalid credentials"` |

State: a `User` with `ACTIVE` status may log in. `DISABLED` (set by a later story) refuses login. A refresh token is created not revoked. Revocation and rotation come in US-04.

## Service-layer types (`src/services/`)

| Type | Shape |
|---|---|
| `LoginCommand` | `email`, `password`, `clientIp` (IP is used for logging only) |
| `LoginResult` | `accessToken`, `refreshToken`, `tokenType: 'Bearer'`, `expiresIn` |
| `AccessTokenSubject` (port input) | `userId`, `customerId \| null`, `roles: Role[]` |
| `IssuedAccessToken` | `token`, `expiresIn` (seconds) |
| `GeneratedRefreshToken` | `value` (clear, base64url, 43 chars), `hash` (SHA-256 hex, 64 chars) |

## Persistence (migration `20261117140000-CreateRefreshTokensAndUserLastLogin`)

### `users` (changed)
| Column | Type | Constraints |
|---|---|---|
| `lastLoginAt` | timestamptz | nullable (`ADD COLUMN IF NOT EXISTS`) |

### `refresh_tokens` (`RefreshTokenEntity`, mapped by `RefreshTokenRepository`)
| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `userId` | uuid | not null, FK → `users(id)` ON DELETE CASCADE, index `IDX_refresh_tokens_user_id` |
| `familyId` | uuid | not null, index `IDX_refresh_tokens_family_id` (family revocation, US-04) |
| `tokenHash` | char(64) | not null, **unique `UQ_refresh_tokens_token_hash`** |
| `createdAt` | timestamptz | not null |
| `expiresAt` | timestamptz | not null |
| `revokedAt` | timestamptz | nullable |
| `replacedBy` | uuid | nullable (successor id, US-04) |

`down()` drops `refresh_tokens` and its indexes, then drops `users."lastLoginAt"`.

## Configuration (`src/config/configuration.ts`)

| Key | Env | Default |
|---|---|---|
| `jwt.refreshTtlSeconds` | `JWT_REFRESH_TTL_SECONDS` | 604800 |
| `jwt.issuer` / `jwt.audience` / `jwt.privateKeyPath` | `JWT_ISSUER` / `JWT_AUDIENCE` / `JWT_PRIVATE_KEY_PATH` | none (fail fast) |
| `rateLimit.login` | `RATE_LIMIT_LOGIN_LIMIT` / `RATE_LIMIT_LOGIN_TTL_MS` | 10 / 60000 |

# Data Model: Current user endpoint and role-based access guards (US-05)

There is no schema change and no migration. `users` (US-01) already has every field `GET /users/me` returns.

## AuthenticatedPrincipal (`src/domain/authenticated-principal.ts`): new value object

| Field | Rule |
|---|---|
| `userId: string` | From `sub`. Must be non-empty. |
| `roles: readonly Role[]` | From `roles`. Must be a non-empty array of known `Role` values; duplicates are removed. |
| `customerId: string \| null` | From `customerId`. When the claim is present it must be a non-empty string; when it is absent the value is `null`. |
| `hasAnyRole(allowed: readonly Role[]): boolean` | Returns true if the two role lists share at least one role. |
| `static fromClaims(claims: unknown)` | Builds the principal, or throws `InvalidAccessTokenError(INVALID_CLAIMS)`. |

The principal is immutable and built only from a token that has already been verified, never from client input.

## InvalidAccessTokenError (`src/domain/errors/invalid-access-token.error.ts`): new

- It always has the fixed message `unauthorized`.
- Its `reason` is an `AccessTokenFailureReason` enum. The reason is logged only and never returned to the client.

| Reason | Cause |
|---|---|
| `MISSING_HEADER` | There is no `Authorization` header. |
| `MALFORMED_HEADER` | The scheme is not Bearer, the value is empty, there are extra spaces, or there are two tokens. |
| `MALFORMED_TOKEN` | The value is not a decodable JWT. |
| `UNSUPPORTED_ALGORITHM` | The `alg` is anything other than `RS256`. |
| `UNKNOWN_KEY` | The `kid` is missing or unknown. |
| `INVALID_SIGNATURE` | The signature does not verify. |
| `EXPIRED` | `exp` is in the past by more than the clock tolerance. |
| `NOT_YET_VALID` | `iat` or `nbf` is in the future by more than the clock tolerance. |
| `CLAIM_MISMATCH` | `iss` or `aud` does not match the configuration. |
| `INVALID_CLAIMS` | `sub`, `iat`, `exp`, `jti` or `roles` is missing or malformed, or `customerId` has the wrong type. |
| `USER_UNAVAILABLE` | The `GET /users/me` user is missing or not `ACTIVE`. |

## CurrentUserReadModel (`src/services/get-current-user.service.ts`): new

`{ id, customerId: string | null, email: string, name: string, roles: Role[], status: UserStatus, createdAt: Date }`

It is mapped from `User`, so the password hash, `updatedAt` and `lastLoginAt` never leave the service.

## CurrentUserResponseDto (`src/dto/current-user-response.dto.ts`): new

| Field | Swagger | Note |
|---|---|---|
| `id` | uuid | |
| `customerId?` | uuid, optional | Left out of the JSON (not `null`) when the user has none, for example an admin. |
| `email` | string | Normalized. |
| `name` | string | |
| `roles` | `Role[]` enum | Current stored roles, not the token's. |
| `status` | `UserStatus` enum | Always `ACTIVE` in a 200 response. |
| `createdAt` | ISO 8601 date-time | |

## Route policy metadata

| Key | Set by | Meaning |
|---|---|---|
| `IS_PUBLIC_KEY` | `@Public()` on a handler or class | No authentication and no role check. |
| `ROLES_KEY` | `@Roles(...roles)` on a handler or class | Authentication is required, and the principal must hold at least one of the listed roles. |

A route is valid when exactly one key applies to it (from the handler or from its class) and its `ROLES_KEY` list is not empty.

## Configuration

`JwtConfig.clockToleranceSeconds: number` comes from `JWT_CLOCK_TOLERANCE_SECONDS`. The default is 5. The value must be a non-negative integer, otherwise startup fails.

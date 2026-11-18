# Contract: access control for every route

## Route policy

| Route | Policy |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | `@Public` (class level on `AuthController`) |
| `GET`/`HEAD /.well-known/jwks.json` | `@Public` |
| `GET /health` | `@Public` |
| `GET /docs`, `/docs-json` | Outside Nest routing, so guards never run on them |
| `GET /users/me` | `@Roles(CUSTOMER, ADMIN)` |
| Any route with neither `@Public` nor `@Roles`, with both, or with an empty `@Roles()` | The app fails at startup with `route policy violation: <Controller>.<handler> (<METHOD> <path>), …` |

## Token checks (protected routes, in order)

1. The `Authorization` header matches `Bearer <token>`. The scheme is case-insensitive, and the header has exactly one token and no extra spaces.
2. The header `alg` is `RS256`, and `kid` names a key published at `/.well-known/jwks.json` (active or retired).
3. The RS256 signature is valid.
4. `iss` equals `JWT_ISSUER`, and `aud` contains `JWT_AUDIENCE`.
5. `exp` is no more than `JWT_CLOCK_TOLERANCE_SECONDS` (default 5) in the past. `iat` and `nbf` are no more than that tolerance in the future.
6. `sub`, `iat`, `exp` and `jti` are present. `roles` is a non-empty list of `CUSTOMER` and/or `ADMIN`. `customerId`, if present, is a non-empty string.
7. The principal holds at least one of the route's roles.

Steps 1–6 fail with 401 and step 7 fails with 403. Verification never calls the network or the database.

## Error responses

The 401 response is the same, byte for byte, for every cause:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json

{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}
```

The 403 response:

```json
{"statusCode":403,"message":"forbidden","error":"Forbidden"}
```

Neither response echoes the token. The failure `reason` is logged at `warn` level with no token or header value.

## Public routes

Public routes ignore the `Authorization` header entirely, so an invalid token does not change their behaviour.

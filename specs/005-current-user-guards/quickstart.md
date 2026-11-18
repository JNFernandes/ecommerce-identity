# Quickstart: validate US-05

## Prerequisites

- Infra is running: in `ecommerce-infra`, run `docker compose up -d`.
- Keys exist: `npm run keys:generate`.
- `.env` sets `JWT_ISSUER`, `JWT_AUDIENCE` and `JWT_PRIVATE_KEY_PATH`. Optionally set `JWT_CLOCK_TOLERANCE_SECONDS` (default 5).
- Run `npm run migration:run && npm run start:dev`.

## 1. Read the current user

```bash
curl -s -X POST localhost:3001/auth/register -H 'content-type: application/json' \
  -d '{"email":"ana@example.com","name":"Ana","password":"Str0ng-pass-123"}'
TOKEN=$(curl -s -X POST localhost:3001/auth/login -H 'content-type: application/json' \
  -d '{"email":"ana@example.com","password":"Str0ng-pass-123"}' | jq -r .accessToken)
curl -si localhost:3001/users/me -H "Authorization: Bearer $TOKEN"
```

Expected: 200 with `id`, `customerId`, `email`, `name`, `roles: ["CUSTOMER"]`, `status`, `createdAt`, and no password field. See [contracts/get-users-me.md](contracts/get-users-me.md).

## 2. Rejections

| Call | Expected |
|---|---|
| `curl -si localhost:3001/users/me` | 401, `WWW-Authenticate: Bearer` |
| `-H "Authorization: Basic $TOKEN"` | The same 401 |
| `-H "Authorization: Bearer ${TOKEN}x"` (tampered token) | The same 401 |
| `-H "Authorization: bearer $TOKEN"` (lower-case scheme) | 200 |

## 3. Public routes still work without a token

Each of these should behave as before: `GET /health`, `GET /.well-known/jwks.json`, `POST /auth/refresh`, `POST /auth/logout` and `GET /docs`.

## 4. Swagger

At `localhost:3001/docs`, `GET /users/me` shows a lock icon, `x-roles: [CUSTOMER, ADMIN]`, and 401 and 403 responses. **Authorize** with `$TOKEN` and try the route.

## 5. Automated checks

```bash
npm run test:unit -- access-token-verifier jwt-auth.guard roles.guard route-policy
npm run test:component -- users-me access-control
```

These cover the verifier attack cases (none, HS256 with the public key, unknown `kid`, retired key), the route policy over every `AppModule` route, 401 for a disabled or deleted user, 403 on the test-only `ADMIN` route, and no tokens in the captured logs.

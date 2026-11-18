# Quickstart: US-06 validation

## Prerequisites

- Local infra is up (`docker compose up -d` in `ecommerce-infra`).
- Keys exist in `keys/`.
- `.env` has the `JWT_*` variables set.

## 1. Seed the admin

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='change-me-now-123' npm run start:dev
```

Expected: the log line "administrator seeded" with an id, and the password nowhere in the output. Restart with a different `ADMIN_PASSWORD`. Expected: no seed log, and the old password still logs in.

## 2. Log in as admin

`POST /auth/login` with those credentials returns 200. Decode the access token: it has `roles: ["ADMIN"]` and no `customerId`.

## 3. List users

Register two customers, then call each of the following with the admin token:

- `GET /users` → 200: newest first, `total` ≥ 3, `limit: 20`, `offset: 0`, `lastLoginAt` present.
- `GET /users?role=CUSTOMER&email=AN` → only customers whose email starts with `an`.
- `GET /users?limit=1&offset=1` → the second-newest user.
- `GET /users?limit=0`, `?limit=101`, `?offset=-1`, `?role=ROOT`, `?foo=1` → 400 with validation details.

## 4. One user

- `GET /users/{id}` → 200 with the same shape.
- An unknown UUID → 404.
- `GET /users/abc` → 400.

## 5. Access control

Call both endpoints with a customer token (expect 403) and with no token (expect 401).

## 6. Misconfiguration

Run each of these on an empty database:

- start without `ADMIN_*` → a warning, and the service is healthy;
- `ADMIN_PASSWORD=short` → an error naming the length rule;
- `ADMIN_EMAIL` set to an existing customer → an error, and the customer is still `CUSTOMER`.

## Automated

Run `npm run test` (unit, integration and component; Docker is required).

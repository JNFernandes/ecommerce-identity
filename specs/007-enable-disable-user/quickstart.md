# Quickstart: US-07 validation

## Prerequisites

- Local infra is up (`docker compose up -d` in `ecommerce-infra`); keys are in `keys/`; `.env` has the `JWT_*` variables set.
- The admin is seeded (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, see US-06). Run `npm run migration:run && npm run start:dev`.

## 1. Disable a customer

Register and log in customer C, and keep C's access token `AT_C` and refresh token `RT_C`. Log in as admin A to get `AT_A`.

- `PATCH /users/{C}/status {"status":"DISABLED"}` with `AT_A` → 200, `status: DISABLED`, same shape as `GET /users/{C}`.
- C logs in → 401. `POST /auth/refresh` with `RT_C` → 401. `GET /users/me` with `AT_C` → 401.
- The log has one `user status changed` line with `actorId`, `targetId`, `from`, `to` and no email or token.

## 2. Idempotent

Repeat the same `DISABLED` call → 200, and no new status-change log line.

## 3. Re-enable

- `{"status":"ACTIVE"}` → 200. `RT_C` still gives 401; C logs in → 200.

## 4. Safeguards

- A disables A → 409 "an admin cannot disable their own account".
- With only A active, a second admin cannot be created through the API. The last-admin and crossed-disable cases are covered by the component tests, which seed a second admin directly.

## 5. Errors and access

- `PATCH /users/abc/status` → 400; unknown UUID → 404; `{"status":"disabled"}`, `{}`, `{"status":"DISABLED","x":1}` → 400.
- Customer token → 403; no token → 401.

## 6. Kafka down

Stop Kafka and repeat step 1 with a new customer → same results.

## Automated

`npm run test` (Docker required).

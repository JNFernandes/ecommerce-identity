# Quickstart: An administrator creates a user with a role (US-09)

## Automated

```bash
npm run test:unit -- create-user audit         # domain, DTO, service, dispatcher
npm run test:integration -- audit              # migration, append-only trigger, atomic commit (Docker)
npm run test:component -- users-create         # endpoint end to end, Kafka up and down (Docker)
```

## Manual (local stack, service on `http://localhost:3001`)

1. Log in as the seeded admin: `POST /auth/login` → keep `accessToken` as `AT_A`.
2. `POST /users` with `AT_A`, roles `["ADMIN"]` → **201**, no `customerId`. Log in as that user →
   **200**; `GET /users` with their token → **200**. No message on `identity.user-registered`.
3. `POST /users` with roles `["CUSTOMER"]` → **201** with `customerId`; one message on
   `identity.user-registered` (key = user id, same fields as a registration).
4. In Postgres: `SELECT "actorId", action, "targetId", "after" FROM audit_records;` → one row per
   creation; `UPDATE audit_records SET action = 'X';` → error `audit records are append-only`.
5. Errors: same email in other case → **409**; roles `[]`, `["CUSTOMER","ADMIN"]`, `["ADMIN","ADMIN"]`,
   `["ROOT"]`, short password, extra `status` → **400**; no token → **401**; customer token → **403**.
6. Disable the admin created in step 2 (`PATCH /users/{id}/status`), then call `POST /users` with
   their still-valid token → **401**.
7. Stop Kafka, create a `["CUSTOMER"]` user → **201**; a `PENDING_RETRY` dead-letter row appears and
   is resolved by the retry worker once Kafka is back.
8. Logs: one `user created: actorId=… targetId=… roles=…` line per creation; no email, password or
   token anywhere.

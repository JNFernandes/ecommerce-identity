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

## Result (2026-11-19, `node dist/main.js` on port 3099 against throwaway `postgres:16-alpine` and `cp-kafka:7.6.1` containers, admin seeded from env)

Throwaway containers kept the local `identity` database and the shared Kafka untouched. Steps 1–6
were driven by a small `fetch` script (one PASS/FAIL line per check, 18/18 PASS).

- **Step 1**: seeded admin logs in. ✅
- **Step 2**: `["ADMIN"]` → 201, no `customerId`, email normalized, name trimmed, no password or hash
  in the body; the new admin logs in (token `roles: ["ADMIN"]`, no `customerId`) and `GET /users` → 200. ✅
- **Step 3**: `["CUSTOMER"]` → 201 with `customerId` ≠ id; exactly one message on
  `identity.user-registered` (key = user id, seven contract fields); none for the admin. ✅
- **Step 4**: two `audit_records` rows (`USER_CREATED`, seeded admin as actor, `after` = roles);
  `UPDATE` and `DELETE` rejected by the trigger. ✅
- **Step 5**: same email in other case → 409; `[]`, both roles, repeated role, unknown role, short
  password, extra `status` → 400; no token → 401; customer token → 403. ✅
- **Step 6**: the created admin disabled, then their still-valid token → 401. ✅
- **Step 7**: Kafka stopped → `["CUSTOMER"]` → 201, dead-letter row `PENDING_RETRY`; Kafka started →
  the retry worker resolved it (`RESOLVED`). ✅
- **Step 8**: one `user created: actorId=… targetId=… roles=…` line per creation; 0 passwords,
  emails or hashes in the log. ✅
- **Automated**: `npm run test`, 1117 tests pass (unit, integration, component). ✅

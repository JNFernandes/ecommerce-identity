# Contract: `POST /users` (US-09)

Admins only (`@Roles(ADMIN)`, bearer access token). Not rate limited.

## Request

```json
{ "email": "  Bea@Example.com ", "name": " Bea ", "password": "correct-horse-battery", "roles": ["ADMIN"] }
```

| Field | Rule |
|---|---|
| `email` | as registration: valid, ≤ 254, trimmed + lowercased |
| `name` | as registration: 1–100 characters after trimming |
| `password` | as registration: 10–128 characters, not equal to the email |
| `roles` | exactly `["CUSTOMER"]` or `["ADMIN"]` |

Any other property → 400 (`forbidNonWhitelisted`), so `id`, `customerId`, `status`, `createdAt`
can never be set.

## Responses

| Status | When | Body |
|---|---|---|
| 201 | created | `GET /users/{id}` shape: `id`, `customerId` (only for `CUSTOMER`), `email`, `name`, `roles`, `status: "ACTIVE"`, `createdAt`, `lastLoginAt: null` |
| 400 | invalid body or rule | standard validation error (`message` lists the problems) |
| 401 | no / invalid token, or acting admin missing / not an `ACTIVE` admin | generic 401 |
| 403 | caller is not `ADMIN` | standard 403 |
| 409 | email already used (any status) | `email already registered` |

Never in the response: password, password hash.

## Side effects

- One `audit_records` row in the same transaction: `actorId`, `action: "USER_CREATED"`,
  `targetId`, `before: null`, `after: { "roles": [...] }`, `occurredAt`.
- `[CUSTOMER]` only: after the commit, one `identity.user-registered` message, key = user id,
  payload identical to registration (`eventId`, `aggregateId`, `occurredAt`, `version`,
  `customerId`, `email`, `name`); on failure logged + dead-lettered (same `eventId`), still 201.
- One log line: `user created: actorId=<uuid> targetId=<uuid> roles=<ROLE>` (no email, name,
  password or token).

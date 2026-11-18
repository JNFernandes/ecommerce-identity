# Contract: `GET /users/me` (`CUSTOMER`, `ADMIN`)

## Request

```http
GET /users/me
Authorization: Bearer <access token>
```

The request has no body or parameters.

## Responses

| Status | When | Body |
|---|---|---|
| 200 | The token is valid and the user exists and is `ACTIVE` | `CurrentUserResponseDto` (below) |
| 401 | Any token failure (see [access-control.md](access-control.md)), or the user is missing or not `ACTIVE` | The generic 401 body, plus `WWW-Authenticate: Bearer` |
| 403 | The token holds neither `CUSTOMER` nor `ADMIN` (not reachable today) | The generic 403 body |
| 5xx | The database is unavailable | The Nest error body. It is never a 401. |

## 200 body

Customer:

```json
{
  "id": "6f1c…",
  "customerId": "a2d4…",
  "email": "ana@example.com",
  "name": "Ana",
  "roles": ["CUSTOMER"],
  "status": "ACTIVE",
  "createdAt": "2026-11-18T10:00:00.000Z"
}
```

For an admin, `customerId` is left out entirely. The response never includes `password`, `passwordHash`, `updatedAt`, `lastLoginAt` or a token.

## Side effects

The endpoint has none. It reads only, publishes no event, and works when Kafka is unreachable.

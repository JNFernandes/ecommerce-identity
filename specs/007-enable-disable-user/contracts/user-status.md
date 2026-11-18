# Contract: `PATCH /users/{id}/status` (`ADMIN`)

Requires `Authorization: Bearer <access token>` with role `ADMIN`. The 401 and 403 bodies are the US-05 generic ones (see `specs/005-current-user-guards/contracts/access-control.md`).

## Request

```json
{ "status": "DISABLED" }
```

| Field | Type | Rule |
|---|---|---|
| `status` | `ACTIVE` \| `DISABLED` | required, exact case; no other field is allowed |

`id` is a UUID path parameter.

## Responses

| Status | When | Body |
|---|---|---|
| 200 | Changed, or already in the requested status (no-op) | `UserSummaryResponseDto`, the same shape as `GET /users/{id}`, with the status after the request |
| 400 | `id` is not a UUID; `status` is missing, unknown, of the wrong case or not a string; unknown field; malformed JSON | Nest validation error |
| 401 | No or invalid token, **or** the acting admin is missing or not `ACTIVE` | generic US-05 401 |
| 403 | The token does not hold `ADMIN` | generic US-05 403 |
| 404 | No user has this id | `{"statusCode":404,"message":"user not found","error":"Not Found"}` |
| 409 | The admin targets their own account with `DISABLED` | `{"statusCode":409,"message":"an admin cannot disable their own account","error":"Conflict"}` |
| 409 | The target is the last `ACTIVE` admin | `{"statusCode":409,"message":"the last active admin cannot be disabled","error":"Conflict"}` |

## Side effects

- `DISABLED` on an `ACTIVE` user: the status and the revocation of every refresh token of the user commit together.
- `ACTIVE` on a `DISABLED` user: only the status changes; revoked tokens stay revoked.
- A no-op writes nothing and logs no status change.
- No event is published, and the endpoint works with Kafka unreachable.
- Access tokens already issued stay valid on token-only routes until `exp`. `GET /users/me`, login, refresh and this endpoint refuse a disabled user.

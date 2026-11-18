# Contract: `GET /users` and `GET /users/{id}` (`ADMIN`)

Both endpoints require `Authorization: Bearer <access token>` with role `ADMIN`. The 401 and 403 bodies are the US-05 generic ones (see `specs/005-current-user-guards/contracts/access-control.md`).

## `GET /users`

### Query parameters

| Name | Type | Default | Rule |
|---|---|---|---|
| `limit` | integer | `20` | 1–100 |
| `offset` | integer | `0` | ≥ 0 |
| `role` | `CUSTOMER` \| `ADMIN` | none | exact role held |
| `status` | `ACTIVE` \| `DISABLED` | none | exact status |
| `email` | string | none | case-insensitive prefix, matched literally, ≤ 254 chars; empty = ignored |

Filters combine with AND. Results are ordered by `createdAt` descending, then `id` descending. Unknown parameters are rejected.

### Responses

| Status | When |
|---|---|
| 200 | `UserPageResponseDto` |
| 400 | Invalid or out-of-range parameter, or an unknown parameter. Body: the Nest validation error, with `message` as a list of strings |
| 401 | No token or an invalid token |
| 403 | The token is valid but does not hold `ADMIN` |

```json
{
  "items": [
    {
      "id": "6f1c…",
      "customerId": "a2d4…",
      "email": "ana@example.com",
      "name": "Ana",
      "roles": ["CUSTOMER"],
      "status": "ACTIVE",
      "createdAt": "2026-11-18T10:00:00.000Z",
      "lastLoginAt": null
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

`customerId` is omitted for users without one (admins). `lastLoginAt` is always present and is `null` until the user's first login. An item never contains `password`, `passwordHash` or `updatedAt`. An offset past the end gives `items: []` with the real `total`.

## `GET /users/{id}`

| Status | When |
|---|---|
| 200 | One `UserSummaryResponseDto` (same shape as a list item) |
| 400 | `id` is not a UUID |
| 401 / 403 | As above |
| 404 | No user has this id. Body: `{"statusCode":404,"message":"user not found","error":"Not Found"}` |

`GET /users/me` is unchanged (US-05) and takes precedence over `{id}`.

## Side effects

Both endpoints are read-only and publish no events.

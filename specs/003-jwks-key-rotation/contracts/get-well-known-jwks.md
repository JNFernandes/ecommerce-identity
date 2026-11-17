# Contract: `GET /.well-known/jwks.json` (and `HEAD`)

Public. No authentication; any `Authorization` header is ignored. Not rate limited. Independent of
Kafka and PostgreSQL.

## Request
| Header | Optional | Meaning |
|---|---|---|
| `If-None-Match` | yes | `*`, or a comma list of entity tags (`W/` prefix ignored) |

## 200 OK
Headers: `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, max-age=<JWKS_CACHE_SECONDS>`, `ETag: "<base64url sha256 of body>"`.

```json
{
  "keys": [
    { "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "<active thumbprint>", "n": "...", "e": "AQAB" },
    { "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "<retired thumbprint>", "n": "...", "e": "AQAB" }
  ]
}
```

- Active key first, then retired keys in configured order.
- Each entry has exactly these six members; never `d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`.
- `kid` equals the `kid` header of tokens signed with that key.
- The body is byte-identical for the same key set across restarts and instances, so the `ETag` is too.

## 304 Not Modified
When `If-None-Match` is `*` or contains the current `ETag`. Empty body; same `Cache-Control` and `ETag`.

## HEAD
Same status and headers as `GET`, no body.

## Other methods
Not served (404); no key data.

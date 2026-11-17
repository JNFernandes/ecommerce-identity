# Quickstart: validate US-03

Prerequisites: `ecommerce-infra` running (`docker compose up -d`), `.env` from `.env.example`, `npm ci`, Docker for component tests.

## 1. Automated
```bash
npm run test:unit -- key-ring jwks if-none-match keys-generate reference-verifier configuration
npm run test:integration -- key-ring-loading
npm run test:component -- jwks signing-key-startup
```
Expect all green, then the full quality gate (CLAUDE.md).

## 2. Endpoint (single key)
```bash
npm run keys:generate            # keys/private.pem + public.pem (skip if present)
npm run start:dev
curl -i http://localhost:3001/.well-known/jwks.json
```
Expect 200, one key with exactly `kty use alg kid n e`, `Cache-Control: public, max-age=300`, an `ETag`. Repeat with `-H 'If-None-Match: <etag>'` → 304, empty body. `curl -I` → same headers. Log in and compare the token header `kid` with the JWKS `kid`. See [contracts/get-well-known-jwks.md](contracts/get-well-known-jwks.md).

## 3. Rotation (runbook dry run)
1. `npm run keys:generate -- --name next` → new pair; default pair untouched. Rerun → refused, nothing written.
2. Log in; keep the access token (old `kid`).
3. Set `JWT_PRIVATE_KEY_PATH=./keys/next-private.pem`, `JWT_RETIRED_PUBLIC_KEY_PATHS=./keys/public.pem`; restart.
4. JWKS lists new key then old; a new login has the new `kid`; the old token still verifies.
5. After 15 min, clear `JWT_RETIRED_PUBLIC_KEY_PATHS`, restart → only the new key listed.

## 4. Fail fast
Start with each and expect exit 1 and a message naming the file/variable, no key content:
`JWT_RETIRED_PUBLIC_KEY_PATHS=./keys/private.pem` (private material), `=./missing.pem`, `=./keys/next-public.pem` while it is also active (duplicate `kid`), `JWKS_CACHE_SECONDS=-1`.

# Quickstart: validate US-02

## Prerequisites
- Docker running. In `ecommerce-infra`, run `docker compose up -d`.
- In this repo, run `npm ci` and then `npm run keys:generate`. This writes `keys/private.pem` and `keys/public.pem` and prints the `kid`.
- In `.env`, set `JWT_PRIVATE_KEY_PATH=./keys/private.pem`, `JWT_ISSUER=ecommerce-identity` and `JWT_AUDIENCE=ecommerce`. Then run `npm run migration:run` and `npm run start:dev`.
- Register `ana@example.com` as in the US-01 quickstart, scenario 1.

## Scenarios

1. **Login (200)**: `curl -i -X POST localhost:3001/auth/login -H 'Content-Type: application/json' -d '{"email":" Ana@Example.com ","password":"correct-horse-battery"}'`. Expect 200 with the fields in [contracts/post-auth-login.md](contracts/post-auth-login.md) and `expiresIn` 900.
2. **Token**: decode the `accessToken` (for example on jwt.io, local tokens only). Its header and claims match [contracts/access-token.md](contracts/access-token.md), and its signature verifies with `keys/public.pem`.
3. **Storage**: `psql -h localhost -p 5435 -U identity_user identity -c 'select "tokenHash","familyId","expiresAt","revokedAt" from refresh_tokens; select "lastLoginAt" from users;'`. Expect one 64-hex-character hash that differs from the returned token, `expiresAt` 7 days after creation, `revokedAt` null, and `lastLoginAt` set.
4. **Generic 401**: log in with a wrong password, then with `nobody@example.com`. Then disable Ana with `update users set status='DISABLED'` and log in again. All three bodies are identical.
5. **Rate limit (429)**: the 11th login within a minute from the same host gets 429.
6. **Fail fast**: unset `JWT_PRIVATE_KEY_PATH`, or point it at a missing or non-RSA file, then run `npm run start:dev`. The service exits with a message naming the problem and no key material.
7. **Kafka down**: in infra, run `docker compose stop kafka`. Scenario 1 still returns 200.

## Automated
Run `npm run test:unit`, `npm run test:integration` and `npm run test:component` (Docker needed). The full quality gate is in CLAUDE.md.

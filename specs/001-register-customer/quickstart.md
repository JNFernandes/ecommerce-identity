# Quickstart: validate US-01

## Prerequisites
- Docker running; in `ecommerce-infra`: `docker compose up -d` (Kafka `localhost:9092`, Postgres `localhost:5435`). The `identity.user-registered` topic must be present in `kafka-init` (linked infra change).
- In this repo: `npm ci`, `npm run migration:run`, `npm run start:dev`.

## Scenarios

1. **Register (201)**: `curl -i -X POST localhost:3001/auth/register -H 'Content-Type: application/json' -d '{"email":"Ana@Example.com ","name":"Ana","password":"correct-horse-battery"}'`. Expect 201 with exactly the fields listed in [contracts/post-auth-register.md](contracts/post-auth-register.md), and email `ana@example.com`.
2. **Stored hash**: `psql -h localhost -p 5435 -U identity_user identity -c 'select "passwordHash", status, roles from users;'`. The hash starts with `$argon2id$`, status is `ACTIVE` and roles is `{CUSTOMER}`.
3. **Event**: in Kafka UI (`localhost:8080`), topic `identity.user-registered` has one message keyed by the user id, with the payload in [contracts/identity.user-registered.md](contracts/identity.user-registered.md).
4. **Duplicate (409)**: repeat scenario 1 with `ANA@example.com`.
5. **Privilege attempt (400)**: add `"roles":["ADMIN"]` to the body.
6. **Rate limit (429)**: send 6 requests within a minute from the same host; the sixth gets 429.
7. **Kafka down**: `docker compose stop kafka` (infra), then register a new email. Expect 201 within about 3 s and one row in `outbound_dead_letters` with status `PENDING_RETRY` and `retryCount` 0.

## Automated
`npm run test:unit`, `npm run test:integration`, `npm run test:component` (Docker needed). The full quality gate is in CLAUDE.md.

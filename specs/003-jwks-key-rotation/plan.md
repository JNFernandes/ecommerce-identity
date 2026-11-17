# Implementation Plan: Publish the signing keys (JWKS) and support key rotation (US-03)

**Branch**: `feature/US-03-jwks-key-rotation` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-jwks-key-rotation/spec.md`

## Summary

A `KeyRing` (infra, jose) loads the active private key (`JWT_PRIVATE_KEY_PATH`) and the retired public keys (`JWT_RETIRED_PUBLIC_KEY_PATHS`) at startup, derives RFC 7638 `kid`s, rejects unparseable files, private material in the retired list, non-RSA/short keys and duplicate `kid`s, and fails fast. It replaces US-02's `loadSigningKey`, exposes the active key as the existing `SigningKey` (token format unchanged), and precomputes the JWKS body and a strong `ETag`. `JwksController` serves `GET`/`HEAD /.well-known/jwks.json`, unthrottled and unauthenticated, with `Cache-Control: public, max-age=JWKS_CACHE_SECONDS` and 304 on a matching `If-None-Match`. `keys:generate` gains `--name`; the README gains the rotation runbook and verification contract, proven by a reference verifier in the tests. Decisions are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), Node.js 20

**Primary Dependencies**: NestJS 10, `jose` 5, `node:crypto`, `@nestjs/swagger`, `@nestjs/throttler` 6. No new packages.

**Storage**: None. Keys are PEM files read once at startup; no migration.

**Testing**: Jest, Supertest, testcontainers (PostgreSQL for component tests; Kafka unreachable via a closed port where needed)

**Target Platform**: Linux container / local Node

**Project Type**: web service (REST microservice)

**Performance Goals**: The JWKS response is a precomputed string; no per-request crypto or I/O.

**Constraints**: No key material in responses, logs or errors (FR-002, FR-008); works without Kafka or the database (FR-011); key set fixed per process.

**Scale/Scope**: 1 active key + a handful of retired keys; one endpoint, one script flag, two settings.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| I. DDD & layering | Pass | Controller → `JwksService` → `PublicKeySet` port (impl. `KeyRing` in infra). No business rules, so no domain change (R8). |
| II. Security | Pass | RS256 only; `/.well-known/jwks.json` publishes several keys with `kid` (constitution requirement); private parameters excluded by allowlist (R6); private key never committed; no key material logged. |
| III. Authorization | Pass | Endpoint is public and documented as such; no role changes. |
| IV. Write flow | N/A | No writes, no events. |
| V. Type safety & validation | Pass | Strict TS, no `any`; env values validated at startup (R12, R13); script args validated (R14). |
| VI/VII. Tests | Pass | Unit, integration (file loading) and component tests incl. rotation and the reference verifier (R15–R17). |
| VIII. Kafka | N/A | Endpoint independent of Kafka. |
| IX. Branching | Pass | `feature/US-03-jwks-key-rotation`, `feat(US-03): ...` commits. |
| X. Quality gate | Pass | build, lint, format:check, test after every task. |

Post-design re-check: no violations; Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-jwks-key-rotation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── get-well-known-jwks.md
│   ├── verification-contract.md
│   └── keys-generate-cli.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── config/configuration.ts            # + jwt.retiredPublicKeyPaths, jwks.cacheSeconds (raw), parseNonNegativeInteger
├── app.module.ts                      # KeyRing factory; SigningKey + PublicKeySet from the ring; JwksService; JwksController
├── controllers/
│   ├── jwks.controller.ts             # NEW GET/HEAD /.well-known/jwks.json
│   └── if-none-match.ts               # NEW ifNoneMatchMatches(header, etag)
├── dto/jwks-response.dto.ts           # NEW Swagger schema (JwkDto, JwksResponseDto)
├── services/
│   ├── jwks.service.ts                # NEW current(): { body, etag, cacheControl }
│   └── ports/public-key-set.ts        # NEW port { json, etag }
└── infra/security/
    ├── key-ring.ts                    # NEW buildKeyRing / loadKeyRing / KeyRing
    ├── signing-key.ts                 # SigningKey + SigningKeyError kept; loadSigningKey removed (logic moves to key-ring)
    └── jose-token-issuer.ts           # unchanged
scripts/keys-generate.ts               # + --name, strict args
tests/
├── support/reference-verifier.ts      # NEW (shared by unit + component)
├── unit/infra/key-ring.spec.ts        # replaces signing-key.spec.ts
├── unit/controllers/{jwks.controller,if-none-match}.spec.ts
├── unit/services/jwks.service.spec.ts
├── unit/support/reference-verifier.spec.ts
├── unit/scripts/keys-generate.spec.ts # + name/force cases
├── unit/config/configuration.spec.ts  # + new settings
├── integration/key-ring-loading.integration.spec.ts
└── component/
    ├── jwks.component.spec.ts         # shape, headers, 304, HEAD, auth ignored, burst, Kafka down
    ├── jwks-rotation.component.spec.ts# old token verifies after rotation; new kid; removal
    ├── jwks-verification.component.spec.ts # reference verifier vs real + forged tokens
    ├── signing-key-startup.component.spec.ts # + retired-key and JWKS_CACHE_SECONDS failures
    └── support/test-app.ts            # key helpers return paths; retired list option
docs/adr/0001-rs256-access-tokens-with-jwks.md  # short US-03 note
README.md, .env.example                # runbook, verification contract, two settings
src/README.md                          # module README: JWKS endpoint, KeyRing wiring
```

**Structure Decision**: Single NestJS service, existing layout. New files follow the US-01/US-02 placement (controllers, dto, services + ports, infra/security, tests by layer).

## Complexity Tracking

None.

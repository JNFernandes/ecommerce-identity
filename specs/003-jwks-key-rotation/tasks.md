---
description: "Task list for US-03: publish the signing keys (JWKS) and support key rotation"
---

# Tasks: Publish the signing keys (JWKS) and support key rotation (US-03)

**Input**: `specs/003-jwks-key-rotation/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Required (constitution VI/VII, FR-016). Each task writes its tests together with the code.

**Order**: Pure logic with unit tests first (key ring, parsers), then file loading and wiring, then
service, then controller (throttling exemption, caching, error-free 304), then script, then the
reference verifier, then component tests, then docs. This story has no domain change, migration,
repository, Kafka event or dead-letter path (plan R8, Constitution IV/VIII: N/A).

**Every task ends with**: the quality gate (`npm run build`, `npm run lint`, `npm run format:check`,
`npm run test`), all green, then one Conventional Commit `feat|test|docs(US-03): ...`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an unfinished task)
- **[USn]**: user story from spec.md

---

## Phase 1: Setup

No new packages, no migration, no scaffolding needed (plan: "No new packages", "Storage: None").

---

## Phase 2: Foundational (blocks every story)

- [X] T001 [P] Add `parseNonNegativeInteger(raw, fallback, name)` (throws `"<name> must be a non-negative integer"`), `jwt.retiredPublicKeyPaths: string[]` via `parseList` and raw `jwks.cacheSeconds` (default `300`) in `src/config/configuration.ts`; cover valid, `0`, negative, decimal, non-numeric, unset and list trimming/empty entries in `tests/unit/config/configuration.spec.ts`
- [X] T002 [P] Create pure `buildKeyRing(active: {path, pem}, retired: [])` in `src/infra/security/key-ring.ts`: move the US-02 active-key parsing (PKCS#8/PKCS#1, RSA, ≥ 2048 bits, RFC 7638 `kid`, `SigningKeyError`) from `src/infra/security/signing-key.ts`; build each JWK from the allowlist `{kty,use,alg,kid,n,e}` (R6); compute `json = JSON.stringify({keys})` and strong `etag = "\"" + base64url(sha256(json)) + "\""` (R7); `KeyRing` exposes `activeKey`, `keys`, `json`, `etag`; JSDoc. Move the active-key cases from `tests/unit/infra/signing-key.spec.ts` into `tests/unit/infra/key-ring.spec.ts` and add: exact six members, no private members, `kid` equals the US-02 thumbprint, same input → same `etag`
- [X] T003 Add `loadKeyRing({activePrivateKeyPath, retiredPublicKeyPaths})` (reads files, error names the path, never content) in `src/infra/security/key-ring.ts`; provide `KeyRing` with an async factory and `SigningKey` via `useFactory: (ring) => ring.activeKey` in `src/app.module.ts` (R2); remove `loadSigningKey` from `src/infra/security/signing-key.ts` and delete `tests/unit/infra/signing-key.spec.ts`; add `tests/integration/key-ring-loading.integration.spec.ts` (temp files: valid active key, missing/unreadable active path). Existing `tests/component/signing-key-startup.component.spec.ts` and login tests must stay green (token format unchanged)
- [X] T004 Create port `PublicKeySet { json: string; etag: string }` with JSDoc in `src/services/ports/public-key-set.ts` and make `KeyRing` implement it in `src/infra/security/key-ring.ts`
- [X] T005 [P] Extend `tests/component/support/test-app.ts`: key helpers return file paths; option to set `JWT_RETIRED_PUBLIC_KEY_PATHS` and `JWKS_CACHE_SECONDS`; helper to write a named key pair (active + public) to a temp dir

**Checkpoint**: Service boots from the key ring; behaviour identical to US-02.

---

## Phase 3: User Story 1 - Services fetch the public keys and verify tokens offline (P1) 🎯 MVP

**Goal**: Public `GET /.well-known/jwks.json` returns the active key as a JWK.

**Independent test**: Active key only → log in, fetch the key set, verify the token with only the fetched keys.

- [X] T006 [US1] Create `JwksService.current(): { body, etag, cacheControl }` (`cacheControl = public, max-age=<n>`) in `src/services/jwks.service.ts`, injecting `PublicKeySet`; register it in `src/app.module.ts` with a factory that calls `parseNonNegativeInteger(config.jwks.cacheSeconds, 300, 'JWKS_CACHE_SECONDS')` so a bad value fails startup (R12); unit tests in `tests/unit/services/jwks.service.spec.ts`
- [X] T007 [P] [US1] Create Swagger DTOs `JwkDto` (six members, documented) and `JwksResponseDto { keys: JwkDto[] }` with JSDoc in `src/dto/jwks-response.dto.ts`
- [X] T008 [US1] Create `JwksController` (`@Controller('.well-known')`, `@Get('jwks.json')`, `@SkipThrottle()`, no guards, JSDoc "public") in `src/controllers/jwks.controller.ts`: `@Res()` writes `body` with `Content-Type: application/json; charset=utf-8`, `Cache-Control` and `ETag`; Swagger `@ApiOkResponse(JwksResponseDto)`; register in `src/app.module.ts`; unit tests in `tests/unit/controllers/jwks.controller.spec.ts`
- [X] T009 [US1] Component tests in `tests/component/jwks.component.spec.ts`: 200 shape with exactly six members and no private members; `kid` equals the `kid` header of a token from `POST /auth/login` and the token verifies with jose `createLocalJWKSet` from the fetched body; `Authorization` (valid/invalid/expired) ignored; 200 with Kafka unreachable (closed port); `HEAD` returns same headers and no body; `POST` on the path → 404 with no key data

**Checkpoint**: MVP — downstream services can verify tokens offline.

---

## Phase 4: User Story 2 - Rotate the signing key without breaking live tokens (P1)

**Goal**: One active signing key plus retired public keys, all published; script creates named pairs.

**Independent test**: Token from key A; restart with B active and A retired; both tokens verify.

- [X] T010 [US2] Support retired keys in `buildKeyRing` in `src/infra/security/key-ring.ts`: accept one `PUBLIC KEY` (SPKI) or `RSA PUBLIC KEY` (PKCS#1) PEM block per file, derive `kid`, append after the active key in configured order; only `activeKey` signs. Unit tests in `tests/unit/infra/key-ring.spec.ts`: SPKI and PKCS#1 accepted, order preserved with several retired keys, `etag` changes when the set changes
- [X] T011 [US2] Pass `config.jwt.retiredPublicKeyPaths` to `loadKeyRing` in `src/app.module.ts`; extend `tests/integration/key-ring-loading.integration.spec.ts` with active + two retired files (order, kids)
- [ ] T012 [P] [US2] Add `--name <name>` (`^[A-Za-z0-9_-]+$`) and `--force` via strict `node:util.parseArgs` in `scripts/keys-generate.ts` (R14, contracts/keys-generate-cli.md): writes `keys/<name>-private.pem` + `keys/<name>-public.pem`; refuses existing pair without `--force` and writes nothing; rejects bad names/unknown flags; prints paths and `kid` only. Tests in `tests/unit/scripts/keys-generate.spec.ts`: default pair untouched by `--name next`, rerun refused, `--force` overwrites, `../x`, `a.b`, empty name and unknown flag rejected with no file written
- [ ] T013 [US2] Component tests in `tests/component/jwks-rotation.component.spec.ts`: login with key A; restart with B active and A retired → JWKS lists B then A, new token has B's `kid`, old A token still verifies (jose `createLocalJWKSet`); restart without A → only B listed, A token fails verification

**Checkpoint**: Rotation works end to end across restarts.

---

## Phase 5: User Story 3 - Unsafe key configuration stops startup (P2)

**Goal**: Every invalid key set or cache setting fails fast with a message naming the file/variable, never key content.

**Independent test**: Boot with each invalid configuration; startup fails with the right message.

- [ ] T014 [US3] Add retired-key rejections in `buildKeyRing` in `src/infra/security/key-ring.ts` (R4, R5): any `PRIVATE` label → "retired keys must be public only" (checked before parsing; no public-half extraction); no block, several blocks or a certificate → unparseable; non-RSA or < 2048 bits; duplicate `kid` across active + retired → error naming both files. Unit tests in `tests/unit/infra/key-ring.spec.ts` for each case, plus asserting no message contains PEM content
- [ ] T015 [P] [US3] Extend `tests/integration/key-ring-loading.integration.spec.ts`: missing and unreadable retired path named in the error; retired path pointing at the active private file rejected as private material; `" a.pem, ,b.pem,"` loads two keys
- [ ] T016 [US3] Extend `tests/component/signing-key-startup.component.spec.ts`: app fails to start for private retired file, missing retired file, duplicate `kid` (active public key listed as retired), 1024-bit retired key, `JWKS_CACHE_SECONDS=-1` and `abc` (message names the variable); captured logs contain no key material; unset/empty retired list starts and publishes one key

**Checkpoint**: Misconfiguration cannot reach a running service.

---

## Phase 6: User Story 4 - Clients cache the key set cheaply (P2)

**Goal**: `Cache-Control`, strong `ETag`, 304 revalidation, no throttling.

**Independent test**: Fetch, check headers, repeat with `If-None-Match: <etag>` → 304.

- [ ] T017 [P] [US4] Create pure `ifNoneMatchMatches(header, etag)` with JSDoc in `src/controllers/if-none-match.ts` (R10: `*` matches; comma list, trim, strip `W/`, compare); unit tests in `tests/unit/controllers/if-none-match.spec.ts` (undefined, exact, list containing it, `W/` prefix, `*`, stale, malformed)
- [ ] T018 [US4] Return 304 (empty body, same `Cache-Control` and `ETag`) when `ifNoneMatchMatches` is true in `src/controllers/jwks.controller.ts`; add Swagger `@ApiResponse({ status: 304 })` and `If-None-Match` `@ApiHeader`; extend `tests/unit/controllers/jwks.controller.spec.ts`
- [ ] T019 [US4] Component tests in `tests/component/jwks-cache.component.spec.ts`: default `max-age=300`; `JWKS_CACHE_SECONDS=60` and `0`; matching `If-None-Match` → 304 empty body same headers; `*` and list → 304; stale → 200; same keys in two app instances → same `ETag`, different keys → different `ETag`; burst of requests above the login limit → no 429

**Checkpoint**: Endpoint is cache-friendly and never throttled.

---

## Phase 7: User Story 5 - Documented verification contract proven by a reference verifier (P3)

**Goal**: A tested reference verifier implementing contracts/verification-contract.md.

**Independent test**: Run the verifier against real and forged tokens.

- [ ] T020 [US5] Create `tests/support/reference-verifier.ts` (R15): `jwtVerify` with `algorithms: ['RS256']`, `issuer`, `audience`; reject missing `kid` before lookup; key by `kid` from a local set; on unknown `kid` refetch once unless a refetch happened < 60 s ago (initial load does not count); injected `fetch` and clock; exposes fetch count. Unit tests in `tests/unit/support/reference-verifier.spec.ts` with jose-built tokens (R16): valid accepted; `alg: none`, HS256 with public PEM as secret, wrong `iss`/`aud`, past `exp`, missing `kid`, altered payload rejected; unknown `kid` right after the initial load → one refetch then reject, second within 60 s → no fetch, after 60 s → refetch; new `kid` after refetch accepted
- [ ] T021 [US5] Component tests in `tests/component/jwks-verification.component.spec.ts`: reference verifier fetching the real endpoint accepts tokens from `POST /auth/login`, rejects the forged set, and after a restart with a rotated key refetches and accepts the new token

**Checkpoint**: Contract proven against the running service.

---

## Phase 8: Polish & Docs

- [ ] T022 Update `README.md`: `GET /.well-known/jwks.json` description, settings `JWT_RETIRED_PUBLIC_KEY_PATHS` and `JWKS_CACHE_SECONDS`, `keys:generate --name/--force`, rotation runbook (generate → make active → previous public key retired → restart → remove after access token lifetime), and the verification contract (RS256 only, key by `kid`, check `iss`/`aud`/`exp`, refetch at most once per minute)
- [ ] T022a [P] Update the module README `src/README.md` (Constitution: module README lists endpoints): `GET`/`HEAD /.well-known/jwks.json` — `JwksController` → `JwksService` → `PublicKeySet` (`KeyRing`), public, unthrottled, no Kafka/DB, `Cache-Control`/`ETag`/304; key loading at startup via `KeyRing` (active + retired keys, fail fast)
- [ ] T023 [P] Add `JWT_RETIRED_PUBLIC_KEY_PATHS=` and `JWKS_CACHE_SECONDS=300` with comments to `.env.example`
- [ ] T024 [P] Add the US-03 note (one signing key + verify-only retired public keys, file-path config, manual rotation) to `docs/adr/0001-rs256-access-tokens-with-jwks.md` (R18); `docs/adr/README.md` unchanged unless the title changes
- [ ] T025 Run `specs/003-jwks-key-rotation/quickstart.md` sections 2–4 by hand and record the result in that file

---

## Dependencies & Execution Order

- **Phase 2**: T001, T002, T005 in parallel; T003 and T004 after T002 (same file `key-ring.ts`).
- **US1** (T006–T009): after Phase 2. T006 needs T001 + T004; T008 needs T006 + T007; T009 needs T008 + T005.
- **US2** (T010–T013): after Phase 2; T013 needs US1's endpoint (T008). T012 independent of everything.
- **US3** (T014–T016): after T010 (same file, retired parsing). T016 needs T006 (cache setting wiring).
- **US4** (T017–T019): T017 any time; T018 after T008; T019 after T018.
- **US5** (T020–T021): T020 any time after Phase 2; T021 after T009 and T013.
- **Polish**: after all stories.

Story completion order: US1 → US2 → US3 → US4 → US5 (US4 can run alongside US2/US3).

## Parallel Examples

- Phase 2: T001 (`configuration.ts`) ‖ T002 (`key-ring.ts`) ‖ T005 (`test-app.ts`)
- US1: T007 (DTO) ‖ T006 (service)
- US2: T012 (`keys-generate.ts`) ‖ T010 (`key-ring.ts`)
- US3: T015 (integration) ‖ T014 (unit + ring)
- US4: T017 (`if-none-match.ts`) ‖ any US2/US3 task
- Polish: T022a ‖ T023 ‖ T024

## Implementation Strategy

1. **MVP**: Phase 2 + US1 → tokens verifiable offline with the single active key; stop and validate.
2. **Rotation**: US2 then US3 (safe rotation before shipping it to operators).
3. **Caching**: US4; **contract**: US5; then docs.
4. One task = one commit after a green gate; never commit on red.

# Data Model: JWKS and key rotation (US-03)

No database change. All objects are in memory, built once at startup and immutable.

## SigningKey (existing, `src/infra/security/signing-key.ts`)
- `privateKey: KeyObject` (RSA, ≥ 2048 bits; never logged or exported), `kid: string` (RFC 7638 SHA-256 thumbprint).
- Exactly one; the only key that signs (FR-005). Source: `JWT_PRIVATE_KEY_PATH`.

## RetiredPublicKey (internal to the ring)
- `path: string`, `publicKey: KeyObject` (RSA, ≥ 2048 bits), `kid: string`.
- Zero or more, from `JWT_RETIRED_PUBLIC_KEY_PATHS` in configured order. Source file: one `PUBLIC KEY` or `RSA PUBLIC KEY` PEM block.

## PublicJwk (published entry)
| Member | Value |
|---|---|
| `kty` | `"RSA"` |
| `use` | `"sig"` |
| `alg` | `"RS256"` |
| `kid` | thumbprint |
| `n`, `e` | base64url modulus / exponent |

Exactly these six members, in this order (R6). No `d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`.

## KeyRing (`src/infra/security/key-ring.ts`, implements `PublicKeySet`)
- `activeKey: SigningKey`
- `keys: readonly PublicJwk[]` — active first, then retired.
- `json: string` — `JSON.stringify({ keys })`, the exact response body.
- `etag: string` — `"<base64url(sha256(json))>"` (strong).

**Validation (fail fast, `SigningKeyError`, message names file or variable, never content)**
- Active: `JWT_PRIVATE_KEY_PATH` unset; file missing/unreadable; not a private PEM; not RSA; < 2048 bits (US-02 rules).
- Retired: missing/unreadable; no PEM block, several blocks or a certificate; a `PRIVATE` label → "retired keys must be public only"; not RSA; < 2048 bits.
- Any two keys (active or retired) with the same `kid` → duplicate error naming both files.

## JwksSnapshot (`JwksService.current()`)
- `body: string` (= `json`), `etag: string`, `cacheControl: string` = `public, max-age=<JWKS_CACHE_SECONDS>`.

## Settings
| Variable | Default | Rule |
|---|---|---|
| `JWT_RETIRED_PUBLIC_KEY_PATHS` | empty | comma list; trimmed; empty entries dropped |
| `JWKS_CACHE_SECONDS` | `300` | non-negative integer, else startup fails naming the variable |

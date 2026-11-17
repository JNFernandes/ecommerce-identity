# Contract: verifying Identity access tokens (downstream services)

Copied into the README; implemented by `tests/support/reference-verifier.ts`.

1. Fetch `GET /.well-known/jwks.json` and cache it (honour `Cache-Control`, revalidate with `ETag`).
2. Accept **RS256 only** (algorithm allowlist). Reject `none`, `HS*` and anything else.
3. Require a `kid` in the header; select the published key with that `kid`. Never try every key.
4. Verify the signature, then `iss` = `JWT_ISSUER`, `aud` contains `JWT_AUDIENCE`, `exp` in the future.
5. Unknown `kid`: refetch the key set **at most once per 60 s**, counted from the previous refetch
   (the initial load does not count); if still unknown, reject.
6. Take `sub`, `customerId` and `roles` only from the verified token.

Reference verifier behaviour proven by the tests:

| Token | Result |
|---|---|
| Valid, from `POST /auth/login` | accepted |
| Signed by the previous key, now retired | accepted (until removed) |
| Signed by the new key, verifier holds the old set | refetch, accepted |
| `alg: none` | rejected |
| HS256 with the public key as secret | rejected |
| Unknown key / `kid` | one refetch, rejected; second within 60 s rejected without fetch |
| Missing `kid`, wrong `iss`, wrong `aud`, past `exp`, altered payload | rejected |

# Contract: `npm run keys:generate`

```text
npm run keys:generate [-- --name <name>] [-- --force]
```

| Argument | Effect |
|---|---|
| none | writes `keys/private.pem` (PKCS#8, 0600) and `keys/public.pem` (SPKI) — unchanged from US-02 |
| `--name <name>` | writes `keys/<name>-private.pem` and `keys/<name>-public.pem`; `<name>` matches `^[A-Za-z0-9_-]+$` |
| `--force` | allows overwriting an existing pair |

- If either file of the target pair exists and `--force` is absent: exit 1, message names the file(s), nothing written.
- Invalid name (path separators, dots, empty, other characters) or unknown flag: exit 1, nothing written.
- Success prints both paths and the `kid`; never prints key material.

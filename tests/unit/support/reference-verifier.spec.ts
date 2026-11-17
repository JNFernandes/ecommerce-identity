import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, JSONWebKeySet, JWK, SignJWT, UnsecuredJWT } from 'jose';
import {
  REFETCH_INTERVAL_MS,
  ReferenceVerifier,
  TokenRejectedError,
} from '../../support/reference-verifier';

const ISSUER = 'identity-test';
const AUDIENCE = 'ecommerce-test';
const START = Date.UTC(2026, 0, 1);

/** An RSA pair with its published JWK. */
interface TestKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: JWK;
  kid: string;
}

/** Generates an RSA key and its public JWK, `kid` = RFC 7638 thumbprint. */
async function newKey(): Promise<TestKey> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(exported, 'sha256');
  return {
    privateKey,
    publicKey,
    kid,
    jwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: exported.n, e: exported.e },
  };
}

/** Claims of a valid token issued at `START`. */
function validClaims(): SignJWT {
  return new SignJWT({ roles: ['CUSTOMER'], customerId: 'c-1' })
    .setSubject('u-1')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(START / 1000)
    .setExpirationTime(START / 1000 + 900);
}

/** A valid RS256 token signed by `key`. */
function signWith(key: TestKey): Promise<string> {
  return validClaims().setProtectedHeader({ alg: 'RS256', kid: key.kid }).sign(key.privateKey);
}

describe('ReferenceVerifier', () => {
  let active: TestKey;
  let rotated: TestKey;

  beforeAll(async () => {
    active = await newKey();
    rotated = await newKey();
  });

  /** A verifier over a mutable published set and a mutable clock. */
  function setup(published: JWK[]): {
    verifier: ReferenceVerifier;
    publish: (keys: JWK[]) => void;
    advance: (ms: number) => void;
  } {
    let keySet: JSONWebKeySet = { keys: published };
    let now = START + 1000;
    const verifier = new ReferenceVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchKeySet: (): Promise<JSONWebKeySet> => Promise.resolve(structuredClone(keySet)),
      now: (): number => now,
    });
    return {
      verifier,
      publish: (keys): void => {
        keySet = { keys };
      },
      advance: (ms): void => {
        now += ms;
      },
    };
  }

  it('should accept a valid token and return its claims', async () => {
    const { verifier } = setup([active.jwk]);

    const payload = await verifier.verify(await signWith(active));

    expect(payload).toMatchObject({ sub: 'u-1', customerId: 'c-1', roles: ['CUSTOMER'] });
    expect(verifier.fetchCount).toBe(1);
  });

  it('should reject alg none', async () => {
    const { verifier } = setup([active.jwk]);
    const token = new UnsecuredJWT({ roles: ['ADMIN'] })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .encode();

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('should reject HS256 signed with the public key PEM as secret', async () => {
    const { verifier } = setup([active.jwk]);
    const secret = Buffer.from(active.publicKey.export({ type: 'spki', format: 'pem' }));
    const token = await validClaims()
      .setProtectedHeader({ alg: 'HS256', kid: active.kid })
      .sign(secret);

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it.each([
    ['a wrong issuer', (jwt: SignJWT): SignJWT => jwt.setIssuer('someone-else')],
    ['a wrong audience', (jwt: SignJWT): SignJWT => jwt.setAudience('other-service')],
    ['a past expiry', (jwt: SignJWT): SignJWT => jwt.setExpirationTime(START / 1000 - 1)],
  ])('should reject %s', async (_case, tweak) => {
    const { verifier } = setup([active.jwk]);
    const token = await tweak(validClaims())
      .setProtectedHeader({ alg: 'RS256', kid: active.kid })
      .sign(active.privateKey);

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('should reject a missing kid before any key lookup', async () => {
    const { verifier } = setup([active.jwk]);
    const token = await validClaims().setProtectedHeader({ alg: 'RS256' }).sign(active.privateKey);

    await expect(verifier.verify(token)).rejects.toThrow(TokenRejectedError);
    expect(verifier.fetchCount).toBe(0);
  });

  it('should reject an altered payload', async () => {
    const { verifier } = setup([active.jwk]);
    const [header, , signature] = (await signWith(active)).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u-1', roles: ['ADMIN'], iss: ISSUER, aud: AUDIENCE }),
    ).toString('base64url');

    await expect(verifier.verify(`${header}.${forged}.${signature}`)).rejects.toThrow();
  });

  it('should refetch once for an unknown kid right after the initial load, then reject', async () => {
    const { verifier } = setup([active.jwk]);
    const unknown = await newKey();

    await expect(verifier.verify(await signWith(unknown))).rejects.toThrow('unknown kid');

    expect(verifier.fetchCount).toBe(2);
  });

  it('should not refetch again within 60 s, and refetch once 60 s have passed', async () => {
    const { verifier, advance } = setup([active.jwk]);
    const token = await signWith(await newKey());
    await expect(verifier.verify(token)).rejects.toThrow('unknown kid');

    advance(REFETCH_INTERVAL_MS - 1);
    await expect(verifier.verify(token)).rejects.toThrow('unknown kid');
    expect(verifier.fetchCount).toBe(2);

    advance(1);
    await expect(verifier.verify(token)).rejects.toThrow('unknown kid');
    expect(verifier.fetchCount).toBe(3);
  });

  it('should accept a new kid published after the initial load', async () => {
    const { verifier, publish } = setup([active.jwk]);
    await verifier.verify(await signWith(active));

    publish([rotated.jwk, active.jwk]);
    const payload = await verifier.verify(await signWith(rotated));

    expect(payload.sub).toBe('u-1');
    expect(verifier.fetchCount).toBe(2);
    await expect(verifier.verify(await signWith(active))).resolves.toBeDefined();
    expect(verifier.fetchCount).toBe(2);
  });
});

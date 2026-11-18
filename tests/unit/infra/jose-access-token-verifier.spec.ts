import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { base64url, JWTPayload, SignJWT } from 'jose';
import { AuthenticatedPrincipal } from '../../../src/domain/authenticated-principal';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../../../src/domain/errors/invalid-access-token.error';
import { Role } from '../../../src/domain/role.enum';
import { JoseAccessTokenVerifier } from '../../../src/infra/auth/jose-access-token-verifier';
import { buildKeyRing, KeyRing } from '../../../src/infra/security/key-ring';
import { AccessTokenVerifier } from '../../../src/services/ports/access-token-verifier';
import { Clock } from '../../../src/services/ports/clock';

const ISSUER = 'https://identity.example.com';
const AUDIENCE = 'ecommerce';
const TOLERANCE = 5;
const NOW = new Date('2026-11-18T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';
const CUSTOMER_ID = '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c';

class FixedClock extends Clock {
  now(): Date {
    return NOW;
  }
}

function generatePair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

interface TokenOverrides {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  omit?: string[];
  key?: KeyObject;
}

describe('JoseAccessTokenVerifier', () => {
  const active = generatePair();
  const retired = generatePair();
  const stranger = generatePair();
  let ring: KeyRing;
  let verifier: JoseAccessTokenVerifier;
  let activeKid: string;
  let retiredKid: string;

  beforeAll(async () => {
    ring = await buildKeyRing(
      {
        path: 'active.pem',
        pem: active.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      [
        {
          path: 'retired.pem',
          pem: retired.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
      ],
    );
    activeKid = ring.keys[0].kid;
    retiredKid = ring.keys[1].kid;
    verifier = await JoseAccessTokenVerifier.create(
      ring.keys,
      { issuer: ISSUER, audience: AUDIENCE, clockToleranceSeconds: TOLERANCE },
      new FixedClock(),
    );
  });

  /** Signs an RS256 token with the active key, valid at {@link NOW} unless overridden. */
  async function sign(overrides: TokenOverrides = {}): Promise<string> {
    const claims: JWTPayload = {
      sub: USER_ID,
      customerId: CUSTOMER_ID,
      roles: ['CUSTOMER'],
      iss: ISSUER,
      aud: AUDIENCE,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 900,
      jti: 'b0e1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
      ...overrides.claims,
    };
    for (const name of overrides.omit ?? []) {
      delete claims[name];
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: activeKid, typ: 'JWT', ...overrides.header })
      .sign(overrides.key ?? active.privateKey);
  }

  async function expectRejected(token: string, reason: AccessTokenFailureReason): Promise<void> {
    let caught: unknown;
    try {
      await verifier.verify(token);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidAccessTokenError);
    const error = caught as InvalidAccessTokenError;
    expect(error.reason).toBe(reason);
    expect(error.message).toBe('unauthorized');
    if (token !== '') {
      expect(error.message).not.toContain(token);
      expect(String(error.reason)).not.toContain(token);
      expect(error.stack ?? '').not.toContain(token);
    }
  }

  it('should be an AccessTokenVerifier', () => {
    expect(verifier).toBeInstanceOf(AccessTokenVerifier);
  });

  it('should turn a valid customer token into a principal', async () => {
    const principal = await verifier.verify(await sign());

    expect(principal).toBeInstanceOf(AuthenticatedPrincipal);
    expect(principal.userId).toBe(USER_ID);
    expect(principal.customerId).toBe(CUSTOMER_ID);
    expect(principal.roles).toEqual([Role.CUSTOMER]);
  });

  it('should accept an admin token without customerId', async () => {
    const principal = await verifier.verify(
      await sign({ claims: { roles: ['ADMIN'] }, omit: ['customerId'] }),
    );

    expect(principal.roles).toEqual([Role.ADMIN]);
    expect(principal.customerId).toBeNull();
  });

  it('should accept a token signed by a retired published key', async () => {
    const token = await sign({ header: { kid: retiredKid }, key: retired.privateKey });

    await expect(verifier.verify(token)).resolves.toBeInstanceOf(AuthenticatedPrincipal);
  });

  it('should accept a token expired within the clock tolerance', async () => {
    const token = await sign({
      claims: { iat: NOW_SECONDS - 900, exp: NOW_SECONDS - (TOLERANCE - 2) },
    });

    await expect(verifier.verify(token)).resolves.toBeInstanceOf(AuthenticatedPrincipal);
  });

  it('should reject a token expired beyond the clock tolerance', async () => {
    const token = await sign({
      claims: { iat: NOW_SECONDS - 900, exp: NOW_SECONDS - (TOLERANCE + 5) },
    });

    await expectRejected(token, AccessTokenFailureReason.EXPIRED);
  });

  it('should accept an iat in the future within the clock tolerance', async () => {
    const token = await sign({ claims: { iat: NOW_SECONDS + TOLERANCE - 1 } });

    await expect(verifier.verify(token)).resolves.toBeInstanceOf(AuthenticatedPrincipal);
  });

  it('should reject an iat in the future beyond the clock tolerance', async () => {
    const token = await sign({ claims: { iat: NOW_SECONDS + 60 } });

    await expectRejected(token, AccessTokenFailureReason.NOT_YET_VALID);
  });

  it('should reject an nbf in the future beyond the clock tolerance', async () => {
    const token = await sign({ claims: { nbf: NOW_SECONDS + 60 } });

    await expectRejected(token, AccessTokenFailureReason.NOT_YET_VALID);
  });

  it('should reject a tampered payload', async () => {
    const [header, , signature] = (await sign()).split('.');
    const payload = base64url.encode(
      JSON.stringify({
        sub: USER_ID,
        roles: ['ADMIN'],
        iss: ISSUER,
        aud: AUDIENCE,
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 900,
        jti: 'x',
      }),
    );

    await expectRejected(
      `${header}.${payload}.${signature}`,
      AccessTokenFailureReason.INVALID_SIGNATURE,
    );
  });

  it('should reject a token signed by an unpublished key under a published kid', async () => {
    await expectRejected(
      await sign({ key: stranger.privateKey }),
      AccessTokenFailureReason.INVALID_SIGNATURE,
    );
  });

  it('should reject alg none', async () => {
    const [, payload] = (await sign()).split('.');
    const header = base64url.encode(JSON.stringify({ alg: 'none', kid: activeKid, typ: 'JWT' }));

    await expectRejected(`${header}.${payload}.`, AccessTokenFailureReason.UNSUPPORTED_ALGORITHM);
  });

  it('should reject HS256 signed with the public key PEM as the secret', async () => {
    const secret = new TextEncoder().encode(
      active.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    const token = await new SignJWT({
      sub: USER_ID,
      roles: ['ADMIN'],
      iss: ISSUER,
      aud: AUDIENCE,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 900,
      jti: 'x',
    })
      .setProtectedHeader({ alg: 'HS256', kid: activeKid, typ: 'JWT' })
      .sign(secret);

    await expectRejected(token, AccessTokenFailureReason.UNSUPPORTED_ALGORITHM);
  });

  it('should reject a wrong issuer', async () => {
    await expectRejected(
      await sign({ claims: { iss: 'https://evil.example.com' } }),
      AccessTokenFailureReason.CLAIM_MISMATCH,
    );
  });

  it('should reject a wrong audience', async () => {
    await expectRejected(
      await sign({ claims: { aud: 'other' } }),
      AccessTokenFailureReason.CLAIM_MISMATCH,
    );
  });

  it('should reject a token without kid', async () => {
    const token = await new SignJWT({
      sub: USER_ID,
      roles: ['CUSTOMER'],
      iss: ISSUER,
      aud: AUDIENCE,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 900,
      jti: 'x',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .sign(active.privateKey);

    await expectRejected(token, AccessTokenFailureReason.UNKNOWN_KEY);
  });

  it('should reject an unknown kid', async () => {
    await expectRejected(
      await sign({ header: { kid: 'unknown-kid' } }),
      AccessTokenFailureReason.UNKNOWN_KEY,
    );
  });

  it.each(['jti', 'sub', 'exp', 'iat'])('should reject a token without %s', async (claim) => {
    await expectRejected(await sign({ omit: [claim] }), AccessTokenFailureReason.INVALID_CLAIMS);
  });

  it('should reject an unknown role', async () => {
    await expectRejected(
      await sign({ claims: { roles: ['ROOT'] } }),
      AccessTokenFailureReason.INVALID_CLAIMS,
    );
  });

  it.each(['not-a-jwt', 'a.b.c', '', 'eyJhbGciOiJSUzI1NiJ9.e30'])(
    'should reject the malformed value %p',
    async (token) => {
      await expectRejected(token, AccessTokenFailureReason.MALFORMED_TOKEN);
    },
  );
});

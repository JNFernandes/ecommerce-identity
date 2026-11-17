import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeProtectedHeader, JWTPayload, jwtVerify } from 'jose';
import { Role } from '../../../src/domain/role.enum';
import { JoseTokenIssuer } from '../../../src/infra/security/jose-token-issuer';
import { loadKeyRing } from '../../../src/infra/security/key-ring';
import { SigningKey } from '../../../src/infra/security/signing-key';
import { TokenIssuer } from '../../../src/services/ports/token-issuer';

const ISSUER = 'https://identity.example.com';
const AUDIENCE = 'ecommerce';
const ISSUED_AT = new Date('2026-11-17T12:00:00.750Z');
const IAT = Math.floor(ISSUED_AT.getTime() / 1000);
const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';
const CUSTOMER_ID = '7a2d3b0f-9e54-4c1a-8b8f-3d6e2f4a5b6c';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('JoseTokenIssuer', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let signingKey: SigningKey;
  let issuer: JoseTokenIssuer;

  beforeAll(async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'issuer-spec-')), 'private.pem');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    signingKey = (await loadKeyRing({ activePrivateKeyPath: path, retiredPublicKeyPaths: [] }))
      .activeKey;
    issuer = new JoseTokenIssuer(signingKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      accessTtlSeconds: 900,
    });
  });

  const customer = { userId: USER_ID, customerId: CUSTOMER_ID, roles: [Role.CUSTOMER] };

  /** Verifies the token at its issue time (the fixed test date is in the past). */
  const verify = async (token: string): Promise<{ payload: JWTPayload }> =>
    jwtVerify(token, publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],
      currentDate: ISSUED_AT,
    });

  it('should be a TokenIssuer', () => {
    expect(issuer).toBeInstanceOf(TokenIssuer);
  });

  it('should set the RS256 header with the key id', async () => {
    const { token } = await issuer.issue(customer, ISSUED_AT);

    expect(decodeProtectedHeader(token)).toEqual({
      alg: 'RS256',
      kid: signingKey.kid,
      typ: 'JWT',
    });
  });

  it('should carry exactly the contract claims and verify with the public key', async () => {
    const { token } = await issuer.issue(customer, ISSUED_AT);

    const { payload } = await verify(token);

    expect(payload).toEqual({
      sub: USER_ID,
      customerId: CUSTOMER_ID,
      roles: ['CUSTOMER'],
      iss: ISSUER,
      aud: AUDIENCE,
      iat: IAT,
      exp: IAT + 900,
      jti: expect.stringMatching(UUID),
    });
  });

  it('should omit customerId when the user has none', async () => {
    const { token } = await issuer.issue(
      { userId: USER_ID, customerId: null, roles: [Role.ADMIN] },
      ISSUED_AT,
    );

    const { payload } = await verify(token);

    expect(payload).not.toHaveProperty('customerId');
    expect(payload.roles).toEqual(['ADMIN']);
  });

  it('should give every token a new jti', async () => {
    const first = await verify((await issuer.issue(customer, ISSUED_AT)).token);
    const second = await verify((await issuer.issue(customer, ISSUED_AT)).token);

    expect(second.payload.jti).not.toBe(first.payload.jti);
  });

  it('should return the configured lifetime', async () => {
    const short = new JoseTokenIssuer(signingKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      accessTtlSeconds: 60,
    });

    const issued = await short.issue(customer, ISSUED_AT);
    const { payload } = await verify(issued.token);

    expect(issued.expiresIn).toBe(60);
    expect(payload.exp).toBe(IAT + 60);
  });

  it('should not verify with another key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { token } = await issuer.issue(customer, ISSUED_AT);

    await expect(jwtVerify(token, other.publicKey, { currentDate: ISSUED_AT })).rejects.toThrow();
  });
});

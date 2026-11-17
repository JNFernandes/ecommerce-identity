import { createHash, generateKeyPairSync, KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import { buildKeyRing, KeyFile } from '../../../src/infra/security/key-ring';
import { SigningKeyError } from '../../../src/infra/security/signing-key';
import { PublicKeySet } from '../../../src/services/ports/public-key-set';

/** PEM export of a private key. */
function pem(key: KeyObject, type: 'pkcs8' | 'pkcs1' = 'pkcs8'): string {
  return key.export({ type, format: 'pem' }).toString();
}

/** A key file named `active.pem` with the given content. */
function activeFile(content: string): KeyFile {
  return { path: 'keys/active.pem', pem: content };
}

/** Asserts that building fails with a `SigningKeyError` naming `problem`, without key data. */
async function expectFailure(
  active: KeyFile,
  problem: string,
  retired: readonly KeyFile[] = [],
): Promise<void> {
  const error: unknown = await buildKeyRing(active, retired).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SigningKeyError);
  const { message } = error as SigningKeyError;
  expect(message).toContain(problem);
  expect(message).not.toContain('BEGIN');
  expect(message).not.toContain('MII');
}

describe('buildKeyRing', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

  describe('active key', () => {
    it('should load a PKCS#8 RSA key and derive the US-02 RFC 7638 kid', async () => {
      const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), []);

      const expectedKid = await calculateJwkThumbprint(await exportJWK(rsa.publicKey), 'sha256');
      expect(ring.activeKey.privateKey.asymmetricKeyType).toBe('rsa');
      expect(ring.activeKey.kid).toBe(expectedKid);
      expect(ring.keys.map((key) => key.kid)).toEqual([expectedKid]);
    });

    it('should accept a PKCS#1 key with the same kid', async () => {
      const pkcs8 = await buildKeyRing(activeFile(pem(rsa.privateKey)), []);
      const pkcs1 = await buildKeyRing(activeFile(pem(rsa.privateKey, 'pkcs1')), []);

      expect(pkcs1.activeKey.kid).toBe(pkcs8.activeKey.kid);
    });

    it('should name the file when it is not a key', async () => {
      await expectFailure(
        activeFile('hello'),
        'does not hold a private key in PEM: keys/active.pem',
      );
    });

    it('should fail for a public key', async () => {
      await expectFailure(
        activeFile(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
        'does not hold a private key',
      );
    });

    it('should fail for an EC key', async () => {
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

      await expectFailure(activeFile(pem(ec.privateKey)), 'must be an RSA private key, got ec');
    });

    it('should fail for a 1024-bit RSA key', async () => {
      const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });

      await expectFailure(activeFile(pem(weak.privateKey)), 'at least 2048 bits, got 1024');
    });
  });

  describe('published key set', () => {
    it('should publish exactly the six allowlisted members and no private member', async () => {
      const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), []);
      const [jwk] = ring.keys;
      const published = (JSON.parse(ring.json) as { keys: Record<string, unknown>[] }).keys[0];

      for (const key of [jwk, published]) {
        expect(Object.keys(key)).toEqual(['kty', 'use', 'alg', 'kid', 'n', 'e']);
        expect(key).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
        for (const privateMember of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
          expect(key).not.toHaveProperty(privateMember);
        }
      }
      expect(ring.json).not.toContain('PRIVATE');
    });

    it('should serialize the set once and derive a strong ETag from the exact body', async () => {
      const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), []);

      expect(ring.json).toBe(JSON.stringify({ keys: ring.keys }));
      expect(ring.etag).toBe(`"${createHash('sha256').update(ring.json).digest('base64url')}"`);
      expect(ring.etag).not.toMatch(/^W\//);
    });

    it('should expose the body and ETag through the PublicKeySet port', async () => {
      const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), []);

      const port: PublicKeySet = ring;

      expect({ json: port.json, etag: port.etag }).toEqual({ json: ring.json, etag: ring.etag });
    });

    it('should give the same body and ETag for the same input', async () => {
      const file = activeFile(pem(rsa.privateKey));

      const [first, second] = await Promise.all([buildKeyRing(file, []), buildKeyRing(file, [])]);

      expect(second.json).toBe(first.json);
      expect(second.etag).toBe(first.etag);
    });

    it('should give a different ETag for a different key', async () => {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

      const first = await buildKeyRing(activeFile(pem(rsa.privateKey)), []);
      const second = await buildKeyRing(activeFile(pem(other.privateKey)), []);

      expect(second.etag).not.toBe(first.etag);
    });
  });

  it('should reject retired keys until they are supported', async () => {
    await expectFailure(activeFile(pem(rsa.privateKey)), 'not supported yet', [
      { path: 'keys/old-public.pem', pem: 'irrelevant' },
    ]);
  });
});

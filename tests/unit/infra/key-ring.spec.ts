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

  describe('retired keys', () => {
    const retiredA = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const retiredB = generateKeyPairSync('rsa', { modulusLength: 2048 });

    /** A retired key file holding `key` in the given public PEM format. */
    const retiredFile = (key: KeyObject, type: 'spki' | 'pkcs1', name: string): KeyFile => ({
      path: `keys/${name}-public.pem`,
      pem: key.export({ type, format: 'pem' }).toString(),
    });

    /** RFC 7638 thumbprint of a public key. */
    const thumbprint = async (key: KeyObject): Promise<string> =>
      calculateJwkThumbprint(await exportJWK(key), 'sha256');

    it.each(['spki', 'pkcs1'] as const)(
      'should accept a %s public key and publish it after the active key',
      async (type) => {
        const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), [
          retiredFile(retiredA.publicKey, type, 'a'),
        ]);

        expect(ring.keys.map((key) => key.kid)).toEqual([
          await thumbprint(rsa.publicKey),
          await thumbprint(retiredA.publicKey),
        ]);
        expect(Object.keys(ring.keys[1])).toEqual(['kty', 'use', 'alg', 'kid', 'n', 'e']);
      },
    );

    it('should keep the configured order of several retired keys', async () => {
      const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), [
        retiredFile(retiredB.publicKey, 'spki', 'b'),
        retiredFile(retiredA.publicKey, 'pkcs1', 'a'),
      ]);

      expect(ring.keys.map((key) => key.kid)).toEqual([
        await thumbprint(rsa.publicKey),
        await thumbprint(retiredB.publicKey),
        await thumbprint(retiredA.publicKey),
      ]);
      expect(JSON.parse(ring.json)).toEqual({ keys: ring.keys });
    });

    it('should sign only with the active key', async () => {
      const ring = await buildKeyRing(activeFile(pem(rsa.privateKey)), [
        retiredFile(retiredA.publicKey, 'spki', 'a'),
      ]);

      expect(ring.activeKey.kid).toBe(await thumbprint(rsa.publicKey));
      expect(ring.activeKey.privateKey.type).toBe('private');
    });

    it('should change the ETag when the key set changes', async () => {
      const active = activeFile(pem(rsa.privateKey));

      const alone = await buildKeyRing(active, []);
      const withA = await buildKeyRing(active, [retiredFile(retiredA.publicKey, 'spki', 'a')]);
      const withAB = await buildKeyRing(active, [
        retiredFile(retiredA.publicKey, 'spki', 'a'),
        retiredFile(retiredB.publicKey, 'spki', 'b'),
      ]);
      const withBA = await buildKeyRing(active, [
        retiredFile(retiredB.publicKey, 'spki', 'b'),
        retiredFile(retiredA.publicKey, 'spki', 'a'),
      ]);

      expect(new Set([alone.etag, withA.etag, withAB.etag, withBA.etag]).size).toBe(4);
    });

    it('should name the file when a retired file is not a key', async () => {
      await expectFailure(activeFile(pem(rsa.privateKey)), 'keys/old-public.pem', [
        { path: 'keys/old-public.pem', pem: 'hello' },
      ]);
    });

    describe('rejections', () => {
      const active = activeFile(pem(rsa.privateKey));
      const publicPem = (key: KeyObject): string =>
        key.export({ type: 'spki', format: 'pem' }).toString();
      const file = (content: string): KeyFile => ({ path: 'keys/old.pem', pem: content });

      it.each([
        ['PKCS#8 private key', (): string => pem(retiredA.privateKey)],
        ['PKCS#1 private key', (): string => pem(retiredA.privateKey, 'pkcs1')],
        [
          'public key followed by a private key',
          (): string => publicPem(retiredA.publicKey) + pem(retiredA.privateKey),
        ],
        [
          'encrypted private key',
          (): string =>
            retiredA.privateKey
              .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' })
              .toString(),
        ],
      ])('should reject a %s as private material', async (_name, content) => {
        await expectFailure(active, 'retired keys must be public only: keys/old.pem', [
          file(content()),
        ]);
      });

      it('should reject the active private key file listed as retired', async () => {
        await expectFailure(active, 'retired keys must be public only: keys/active.pem', [active]);
      });

      it.each([
        ['no PEM block', (): string => 'not a key'],
        [
          'two public key blocks',
          (): string => publicPem(retiredA.publicKey) + publicPem(retiredB.publicKey),
        ],
        [
          'a certificate',
          (): string => '-----BEGIN CERTIFICATE-----\nMIIBAA==\n-----END CERTIFICATE-----\n',
        ],
        [
          'a corrupt public key block',
          (): string => '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
        ],
      ])('should reject %s as unparseable', async (_name, content) => {
        await expectFailure(
          active,
          'must hold exactly one PUBLIC KEY or RSA PUBLIC KEY PEM block: keys/old.pem',
          [file(content())],
        );
      });

      it('should reject a non-RSA public key', async () => {
        const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

        await expectFailure(active, 'retired public key must be RSA, got ec: keys/old.pem', [
          file(publicPem(ec.publicKey)),
        ]);
      });

      it('should reject a 1024-bit retired key', async () => {
        const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });

        await expectFailure(active, 'at least 2048 bits, got 1024: keys/old.pem', [
          file(publicPem(weak.publicKey)),
        ]);
      });

      it('should reject the active public key listed as retired, naming both files', async () => {
        await expectFailure(
          active,
          'duplicate key id: keys/active.pem and keys/old.pem hold the same key',
          [file(publicPem(rsa.publicKey))],
        );
      });

      it('should reject the same retired key listed twice, naming both files', async () => {
        await expectFailure(
          active,
          'duplicate key id: keys/a-public.pem and keys/b-public.pem hold the same key',
          [
            retiredFile(retiredA.publicKey, 'spki', 'a'),
            retiredFile(retiredA.publicKey, 'pkcs1', 'b'),
          ],
        );
      });
    });
  });
});

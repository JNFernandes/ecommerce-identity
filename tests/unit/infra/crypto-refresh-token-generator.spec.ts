import { createHash } from 'node:crypto';
import { CryptoRefreshTokenGenerator } from '../../../src/infra/security/crypto-refresh-token-generator';
import { RefreshTokenGenerator } from '../../../src/services/ports/refresh-token-generator';

describe('CryptoRefreshTokenGenerator', () => {
  const generator = new CryptoRefreshTokenGenerator();

  it('should be a RefreshTokenGenerator', () => {
    expect(generator).toBeInstanceOf(RefreshTokenGenerator);
  });

  it('should generate a 43-character base64url value (256 bits)', () => {
    const { value } = generator.generate();

    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  });

  it('should return the SHA-256 hex digest of the value as its hash', () => {
    const { value, hash } = generator.generate();

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(value).digest('hex'));
    expect(generator.hash(value)).toBe(hash);
  });

  it('should generate a different value every time', () => {
    const values = new Set(Array.from({ length: 100 }, () => generator.generate().value));

    expect(values.size).toBe(100);
  });
});

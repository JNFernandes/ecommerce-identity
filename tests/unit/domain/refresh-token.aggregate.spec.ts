import { RefreshToken, RefreshTokenProps } from '../../../src/domain/refresh-token.aggregate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = 'a'.repeat(64);
const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';
const ISSUED_AT = new Date('2026-11-17T12:00:00.000Z');

describe('RefreshToken', () => {
  describe('issue', () => {
    const issue = (ttlSeconds = 604800, tokenHash = HASH): RefreshToken =>
      RefreshToken.issue({ userId: USER_ID, tokenHash, issuedAt: ISSUED_AT, ttlSeconds });

    it('should create a non-revoked token with new ids', () => {
      const token = issue();

      expect(token.id).toMatch(UUID);
      expect(token.familyId).toMatch(UUID);
      expect(token.userId).toBe(USER_ID);
      expect(token.tokenHash).toBe(HASH);
      expect(token.createdAt).toEqual(ISSUED_AT);
      expect(token.revokedAt).toBeNull();
      expect(token.replacedBy).toBeNull();
    });

    it('should expire ttlSeconds after issue', () => {
      expect(issue(604800).expiresAt).toEqual(new Date('2026-11-24T12:00:00.000Z'));
    });

    it('should give each token a new id and family', () => {
      const first = issue();
      const second = issue();

      expect(second.id).not.toBe(first.id);
      expect(second.familyId).not.toBe(first.familyId);
      expect(first.familyId).not.toBe(first.id);
    });

    it.each([0, -1, Number.NaN])('should reject a lifetime of %p', (ttl) => {
      expect(() => issue(ttl)).toThrow('refresh token lifetime must be positive');
    });

    it('should reject an empty hash', () => {
      expect(() => issue(60, '')).toThrow('refresh token hash must not be empty');
    });
  });

  describe('restore', () => {
    it('should rebuild the token exactly as stored', () => {
      const props: RefreshTokenProps = {
        id: '11111111-1111-4111-8111-111111111111',
        userId: USER_ID,
        familyId: '22222222-2222-4222-8222-222222222222',
        tokenHash: HASH,
        createdAt: ISSUED_AT,
        expiresAt: new Date('2026-11-24T12:00:00.000Z'),
        revokedAt: new Date('2026-11-18T12:00:00.000Z'),
        replacedBy: '33333333-3333-4333-8333-333333333333',
      };

      const token = RefreshToken.restore(props);

      expect({
        id: token.id,
        userId: token.userId,
        familyId: token.familyId,
        tokenHash: token.tokenHash,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt,
        replacedBy: token.replacedBy,
      }).toEqual(props);
    });
  });
});

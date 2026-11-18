import { RefreshTokenState } from '../../../src/domain/refresh-token-state.enum';
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

  describe('rotation rules', () => {
    const FAMILY_ID = '0b9d7c1e-3f4a-4c2b-8e6d-5a1f2b3c4d5e';
    const EXPIRES_AT = new Date('2026-11-24T12:00:00.000Z');
    const NOW = new Date('2026-11-20T00:00:00.000Z');
    const NEXT_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
    const stored = (overrides: Partial<RefreshTokenProps> = {}): RefreshToken =>
      RefreshToken.restore({
        id: '1d2c3b4a-5e6f-4a1b-9c2d-3e4f5a6b7c8d',
        userId: USER_ID,
        familyId: FAMILY_ID,
        tokenHash: HASH,
        createdAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        revokedAt: null,
        replacedBy: null,
        ...overrides,
      });
    const revoked = (): RefreshToken => stored({ revokedAt: new Date('2026-11-18T00:00:00.000Z') });

    describe('assess', () => {
      it('should be USABLE before expiry when not revoked', () => {
        expect(stored().assess(NOW)).toBe(RefreshTokenState.USABLE);
      });

      it('should be EXPIRED exactly at expiresAt', () => {
        expect(stored().assess(EXPIRES_AT)).toBe(RefreshTokenState.EXPIRED);
      });

      it('should be REUSED when revoked', () => {
        expect(revoked().assess(NOW)).toBe(RefreshTokenState.REUSED);
      });

      it('should be REUSED when both revoked and expired', () => {
        expect(revoked().assess(new Date('2026-12-01T00:00:00.000Z'))).toBe(
          RefreshTokenState.REUSED,
        );
      });
    });

    describe('isUsable', () => {
      it('should be true just before expiresAt', () => {
        expect(stored().isUsable(new Date(EXPIRES_AT.getTime() - 1))).toBe(true);
      });

      it('should be false exactly at expiresAt', () => {
        expect(stored().isUsable(EXPIRES_AT)).toBe(false);
      });
    });

    describe('rotate', () => {
      it('should set revokedAt to now and replacedBy to the successor', () => {
        const token = stored();

        token.rotate(NEXT_ID, NOW);

        expect(token.revokedAt).toEqual(NOW);
        expect(token.replacedBy).toBe(NEXT_ID);
      });

      it('should refuse to rotate a revoked token', () => {
        expect(() => revoked().rotate(NEXT_ID, NOW)).toThrow(
          'only a usable refresh token can be rotated',
        );
      });

      it('should refuse to rotate an expired token', () => {
        expect(() => stored().rotate(NEXT_ID, EXPIRES_AT)).toThrow(
          'only a usable refresh token can be rotated',
        );
      });

      it('should refuse an empty successor id', () => {
        expect(() => stored().rotate('', NOW)).toThrow('successor token id must not be empty');
      });
    });

    describe('issueInFamily', () => {
      const issueInFamily = (tokenHash = HASH, expiresAt = EXPIRES_AT): RefreshToken =>
        RefreshToken.issueInFamily({
          userId: USER_ID,
          familyId: FAMILY_ID,
          tokenHash,
          issuedAt: ISSUED_AT,
          expiresAt,
        });

      it('should keep the family and get a new id', () => {
        const previous = stored();
        const next = issueInFamily();

        expect(next.familyId).toBe(FAMILY_ID);
        expect(next.id).toMatch(UUID);
        expect(next.id).not.toBe(previous.id);
        expect(next.userId).toBe(USER_ID);
        expect(next.createdAt).toEqual(ISSUED_AT);
        expect(next.expiresAt).toEqual(EXPIRES_AT);
        expect(next.revokedAt).toBeNull();
        expect(next.replacedBy).toBeNull();
      });

      it('should reject an empty hash', () => {
        expect(() => issueInFamily('')).toThrow('refresh token hash must not be empty');
      });

      it('should reject an expiry that is not after the issue time', () => {
        expect(() => issueInFamily(HASH, ISSUED_AT)).toThrow(
          'refresh token must expire after it is issued',
        );
      });
    });
  });
});

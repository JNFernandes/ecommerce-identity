import { Email } from '../../../src/domain/email.value-object';
import { RefreshFailureReason } from '../../../src/domain/errors/invalid-refresh-token.error';
import { RefreshPolicy } from '../../../src/domain/refresh-policy';
import { RefreshToken } from '../../../src/domain/refresh-token.aggregate';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import { UserStatus } from '../../../src/domain/user-status.enum';

const NOW = new Date('2026-11-20T00:00:00.000Z');
const BEFORE_NOW = new Date('2026-11-18T00:00:00.000Z');
const AFTER_NOW = new Date('2026-11-24T00:00:00.000Z');

function token(expiresAt: Date, revokedAt: Date | null): RefreshToken {
  return RefreshToken.restore({
    id: '1d2c3b4a-5e6f-4a1b-9c2d-3e4f5a6b7c8d',
    userId: '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b',
    familyId: '0b9d7c1e-3f4a-4c2b-8e6d-5a1f2b3c4d5e',
    tokenHash: 'a'.repeat(64),
    createdAt: new Date('2026-11-17T00:00:00.000Z'),
    expiresAt,
    revokedAt,
    replacedBy: null,
  });
}

function user(status: UserStatus): User {
  const registered = User.registerCustomer(
    Email.create('ana@example.com'),
    UserName.create('Ana'),
    'hash',
  );
  return User.restore({
    id: registered.id,
    customerId: registered.customerId,
    email: registered.email,
    name: registered.name,
    passwordHash: 'hash',
    roles: registered.roles,
    status,
    createdAt: registered.createdAt,
    updatedAt: registered.updatedAt,
    lastLoginAt: null,
  });
}

describe('RefreshPolicy', () => {
  const active = user(UserStatus.ACTIVE);
  const disabled = user(UserStatus.DISABLED);
  const usable = token(AFTER_NOW, null);

  it('should rotate a usable token of an active user', () => {
    expect(RefreshPolicy.decide({ token: usable, user: active, now: NOW })).toEqual({
      kind: 'rotate',
    });
  });

  it('should refuse an unknown token without revoking anything', () => {
    expect(RefreshPolicy.decide({ token: null, user: null, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.UNKNOWN,
      revokeFamily: false,
    });
  });

  it('should refuse a used token and revoke the whole family', () => {
    const used = token(AFTER_NOW, BEFORE_NOW);

    expect(RefreshPolicy.decide({ token: used, user: active, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.REUSED,
      revokeFamily: true,
    });
  });

  it('should treat a token that is both revoked and expired as reuse', () => {
    const revokedAndExpired = token(BEFORE_NOW, BEFORE_NOW);

    expect(RefreshPolicy.decide({ token: revokedAndExpired, user: active, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.REUSED,
      revokeFamily: true,
    });
  });

  it('should refuse an expired, unused token without revoking the family', () => {
    const expired = token(BEFORE_NOW, null);

    expect(RefreshPolicy.decide({ token: expired, user: active, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.EXPIRED,
      revokeFamily: false,
    });
  });

  it('should refuse a usable token of a disabled user and revoke the family', () => {
    expect(RefreshPolicy.decide({ token: usable, user: disabled, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.INACTIVE_USER,
      revokeFamily: true,
    });
  });

  it('should refuse a usable token whose owner no longer exists and revoke the family', () => {
    expect(RefreshPolicy.decide({ token: usable, user: null, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.INACTIVE_USER,
      revokeFamily: true,
    });
  });

  it('should refuse an expired token of a disabled user as expired, keeping the family', () => {
    const expired = token(BEFORE_NOW, null);

    expect(RefreshPolicy.decide({ token: expired, user: disabled, now: NOW })).toEqual({
      kind: 'refuse',
      reason: RefreshFailureReason.EXPIRED,
      revokeFamily: false,
    });
  });
});

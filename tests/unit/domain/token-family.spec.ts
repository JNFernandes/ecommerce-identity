import {
  InvalidRefreshTokenError,
  RefreshFailureReason,
} from '../../../src/domain/errors/invalid-refresh-token.error';
import { TokenFamily } from '../../../src/domain/token-family';

const STARTED_AT = new Date('2026-11-01T00:00:00.000Z');
const DAY = 86400;
const THIRTY_DAYS = 30 * DAY;
const SEVEN_DAYS = 7 * DAY;

describe('TokenFamily', () => {
  const family = (): TokenFamily =>
    TokenFamily.create({ startedAt: STARTED_AT, maxSeconds: THIRTY_DAYS });

  it('should end the session maxSeconds after it started', () => {
    expect(family().expiresAt).toEqual(new Date('2026-12-01T00:00:00.000Z'));
  });

  it('should use the refresh lifetime when the session end is far away', () => {
    const now = new Date('2026-11-05T00:00:00.000Z');

    expect(family().nextTokenExpiry(now, SEVEN_DAYS)).toEqual(new Date('2026-11-12T00:00:00.000Z'));
  });

  it('should cap the expiry at the session end near the end of the session', () => {
    const now = new Date('2026-11-28T00:00:00.000Z');

    expect(family().nextTokenExpiry(now, SEVEN_DAYS)).toEqual(new Date('2026-12-01T00:00:00.000Z'));
  });

  it('should refuse with SESSION_EXPIRED exactly at the session end', () => {
    const now = new Date('2026-12-01T00:00:00.000Z');

    expect(() => family().nextTokenExpiry(now, SEVEN_DAYS)).toThrow(InvalidRefreshTokenError);
    try {
      family().nextTokenExpiry(now, SEVEN_DAYS);
    } catch (error) {
      expect((error as InvalidRefreshTokenError).reason).toBe(RefreshFailureReason.SESSION_EXPIRED);
    }
  });

  it('should refuse with SESSION_EXPIRED after the session end', () => {
    const now = new Date('2026-12-02T00:00:00.000Z');

    expect(() => family().nextTokenExpiry(now, SEVEN_DAYS)).toThrow('invalid refresh token');
  });

  it.each([0, -1, Number.NaN])('should reject a session lifetime of %p', (maxSeconds) => {
    expect(() => TokenFamily.create({ startedAt: STARTED_AT, maxSeconds })).toThrow(
      'session lifetime must be positive',
    );
  });
});

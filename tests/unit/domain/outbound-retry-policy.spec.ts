import {
  decideRetry,
  nextRetryDelay,
  OutboundRetryStatus,
  RetryPolicySettings,
} from '../../../src/domain/outbound/retry-policy';

const DEFAULTS: RetryPolicySettings = {
  maxAttempts: 10,
  baseDelayMs: 5000,
  multiplier: 2,
  maxDelayMs: 300000,
};

const NOW = new Date('2026-11-19T10:00:00.000Z');

describe('nextRetryDelay', () => {
  it('should follow the documented delay table with the default settings', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((attempt) => nextRetryDelay(attempt, DEFAULTS));

    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300].map((s) => s * 1000));
  });

  it('should stay finite and capped for a very large attempt number', () => {
    expect(nextRetryDelay(1000, DEFAULTS)).toBe(300000);
    expect(nextRetryDelay(Number.MAX_SAFE_INTEGER, { ...DEFAULTS, multiplier: 1e10 })).toBe(300000);
  });

  it('should keep the delay constant when the multiplier is 1', () => {
    const constant = { ...DEFAULTS, multiplier: 1 };

    expect([1, 2, 5, 20].map((attempt) => nextRetryDelay(attempt, constant))).toEqual([
      5000, 5000, 5000, 5000,
    ]);
  });

  it('should use the base delay for the first attempt', () => {
    expect(nextRetryDelay(1, { ...DEFAULTS, multiplier: 3 })).toBe(5000);
  });
});

describe('decideRetry', () => {
  it('should resolve the row on success, clearing the last error', () => {
    expect(decideRetry(2, { kind: 'success' }, NOW, DEFAULTS)).toEqual({
      status: OutboundRetryStatus.RESOLVED,
      retryCount: 3,
      lastAttemptAt: NOW,
      lastError: null,
      resolvedAt: NOW,
    });
  });

  it('should reschedule a transient failure below the maximum with the backoff delay', () => {
    expect(decideRetry(2, { kind: 'transient', error: 'broker down' }, NOW, DEFAULTS)).toEqual({
      status: OutboundRetryStatus.PENDING_RETRY,
      retryCount: 3,
      lastAttemptAt: NOW,
      lastError: 'broker down',
      nextRetryAt: new Date(NOW.getTime() + 20000),
    });
  });

  it('should exhaust the row when a transient failure reaches the maximum attempts', () => {
    const decision = decideRetry(9, { kind: 'transient', error: 'broker down' }, NOW, DEFAULTS);

    expect(decision).toEqual({
      status: OutboundRetryStatus.EXHAUSTED,
      retryCount: 10,
      lastAttemptAt: NOW,
      lastError: 'broker down',
    });
    expect(decision.nextRetryAt).toBeUndefined();
  });

  it('should exhaust the row on the first failure when the maximum is 1', () => {
    const decision = decideRetry(0, { kind: 'transient', error: 'x' }, NOW, {
      ...DEFAULTS,
      maxAttempts: 1,
    });

    expect(decision.status).toBe(OutboundRetryStatus.EXHAUSTED);
    expect(decision.retryCount).toBe(1);
  });

  it('should exhaust the row at once on a permanent failure', () => {
    expect(
      decideRetry(0, { kind: 'permanent', error: 'malformed payload' }, NOW, DEFAULTS),
    ).toEqual({
      status: OutboundRetryStatus.EXHAUSTED,
      retryCount: 1,
      lastAttemptAt: NOW,
      lastError: 'malformed payload',
    });
  });
});

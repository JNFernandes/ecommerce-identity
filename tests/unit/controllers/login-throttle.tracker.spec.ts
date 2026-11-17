import { ExecutionContext } from '@nestjs/common';
import { loginThrottleTracker } from '../../../src/controllers/login-throttle.tracker';

const context = {} as ExecutionContext;

/** Builds a tracker that always returns a promise, whatever the tracker returns. */
function tracker(kind: 'ip' | 'email'): (req: Record<string, unknown>) => Promise<string> {
  const track = loginThrottleTracker(kind);
  return (req) => Promise.resolve(track(req, context));
}

describe('loginThrottleTracker', () => {
  describe('email', () => {
    const track = tracker('email');

    it('should key every IP and casing of one email to the same bucket', async () => {
      const keys = await Promise.all([
        track({ ip: '203.0.113.1', body: { email: 'ana@example.com' } }),
        track({ ip: '198.51.100.2', body: { email: ' Ana@Example.COM ' } }),
        track({ ip: '192.0.2.3', body: { email: 'ANA@EXAMPLE.COM' } }),
      ]);

      expect(new Set(keys)).toEqual(new Set(['email:ana@example.com']));
    });

    it('should key different emails to different buckets', async () => {
      const ana = await track({ ip: '203.0.113.1', body: { email: 'ana@example.com' } });
      const bob = await track({ ip: '203.0.113.1', body: { email: 'bob@example.com' } });

      expect(ana).not.toBe(bob);
    });

    it.each([
      ['no body', {}],
      ['no email', { body: {} }],
      ['a non-string email', { body: { email: 42 } }],
      ['a non-object body', { body: 'text' }],
    ])('should fall back to the IP for %s', async (_case, req) => {
      await expect(track({ ip: '203.0.113.9', ...req })).resolves.toBe('ip:203.0.113.9');
    });
  });

  describe('ip', () => {
    const track = tracker('ip');

    it('should key on the client IP whatever the email', async () => {
      await expect(track({ ip: '203.0.113.1', body: { email: 'ana@example.com' } })).resolves.toBe(
        '203.0.113.1',
      );
    });

    it('should use a fixed key when the IP is unknown', async () => {
      await expect(track({})).resolves.toBe('unknown');
    });
  });
});

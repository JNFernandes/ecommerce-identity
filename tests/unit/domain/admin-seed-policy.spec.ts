import { AdminSeedDecision, AdminSeedPolicy } from '../../../src/domain/admin-seed-policy';
import { Email } from '../../../src/domain/email.value-object';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';

describe('AdminSeedPolicy', () => {
  describe('precheck', () => {
    it('should skip silently when an admin already exists', () => {
      expect(AdminSeedPolicy.precheck({ adminExists: true, configured: true })).toBe(
        AdminSeedDecision.SKIP_ADMIN_EXISTS,
      );
    });

    it('should prefer an existing admin over a missing configuration', () => {
      expect(AdminSeedPolicy.precheck({ adminExists: true, configured: false })).toBe(
        AdminSeedDecision.SKIP_ADMIN_EXISTS,
      );
    });

    it('should skip as not configured when no admin exists and the variables are missing', () => {
      expect(AdminSeedPolicy.precheck({ adminExists: false, configured: false })).toBe(
        AdminSeedDecision.SKIP_NOT_CONFIGURED,
      );
    });

    it('should proceed when no admin exists and the seed is configured', () => {
      expect(AdminSeedPolicy.precheck({ adminExists: false, configured: true })).toBe(
        AdminSeedDecision.PROCEED,
      );
    });
  });

  describe('decide', () => {
    it('should create the admin when the email is free', () => {
      expect(AdminSeedPolicy.decide({ emailOwner: null })).toBe(AdminSeedDecision.CREATE);
    });

    it('should skip when the email belongs to an existing user', () => {
      const customer = User.registerCustomer(
        Email.create('ana@example.com'),
        UserName.create('Ana'),
        'hash',
      );

      expect(AdminSeedPolicy.decide({ emailOwner: customer })).toBe(
        AdminSeedDecision.SKIP_EMAIL_TAKEN,
      );
    });
  });
});

import { AuditAction } from '../../../src/domain/audit/audit-action.enum';
import { AuditRecord } from '../../../src/domain/audit/audit-record';
import { Email } from '../../../src/domain/email.value-object';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';

const AT = new Date('2026-11-19T10:00:00.000Z');
const ACTOR = '0f8fad5b-d9cb-469f-a165-70867728950e';

function admin(): User {
  return User.registerAdmin(Email.create('bea@example.com'), UserName.create('Bea'), 'hash');
}

function customer(): User {
  return User.registerCustomer(Email.create('ana@example.com'), UserName.create('Ana'), 'hash');
}

describe('AuditRecord.userCreated', () => {
  it('should record who created which admin, with only the roles after', () => {
    const user = admin();

    const record = AuditRecord.userCreated(ACTOR, user, AT);

    expect(record.actorId).toBe(ACTOR);
    expect(record.action).toBe(AuditAction.USER_CREATED);
    expect(record.targetId).toBe(user.id);
    expect(record.before).toBeNull();
    expect(record.after).toEqual({ roles: [Role.ADMIN] });
    expect(record.occurredAt).toBe(AT);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should record a customer creation with the CUSTOMER role', () => {
    const user = customer();

    expect(AuditRecord.userCreated(ACTOR, user, AT).after).toEqual({ roles: [Role.CUSTOMER] });
  });

  it('should hold nothing but the roles, so no email, name, hash or token can leak', () => {
    const record = AuditRecord.userCreated(ACTOR, customer(), AT);

    expect(Object.keys(record.after)).toEqual(['roles']);
    expect(JSON.stringify(record.after)).not.toMatch(/ana@example\.com|Ana|hash/);
  });

  it('should keep its own copy of the roles', () => {
    const user = admin();
    const record = AuditRecord.userCreated(ACTOR, user, AT);

    user.roles.push(Role.CUSTOMER);

    expect(record.after).toEqual({ roles: [Role.ADMIN] });
  });

  it('should give every record a new id', () => {
    const user = admin();

    expect(AuditRecord.userCreated(ACTOR, user, AT).id).not.toBe(
      AuditRecord.userCreated(ACTOR, user, AT).id,
    );
  });
});

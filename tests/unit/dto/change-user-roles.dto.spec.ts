import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '../../../src/domain/role.enum';
import { ChangeUserRolesDto } from '../../../src/dto/change-user-roles.dto';

/** Validates a raw body as the global pipe does and returns the names of the invalid properties. */
async function invalidProperties(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(ChangeUserRolesDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property).sort();
}

describe('ChangeUserRolesDto', () => {
  it.each([[[Role.CUSTOMER]], [[Role.ADMIN]], [[Role.ADMIN, Role.CUSTOMER]]])(
    'should accept %p',
    async (roles) => {
      await expect(invalidProperties({ roles })).resolves.toEqual([]);
    },
  );

  it('should reject missing roles', async () => {
    await expect(invalidProperties({})).resolves.toEqual(['roles']);
  });

  it.each([[[]], [['OWNER']], [['admin']], [[Role.ADMIN, Role.ADMIN]], ['ADMIN'], [null]])(
    'should reject the roles %p',
    async (roles) => {
      await expect(invalidProperties({ roles })).resolves.toEqual(['roles']);
    },
  );

  it('should reject an extra field', async () => {
    await expect(invalidProperties({ roles: [Role.ADMIN], x: 1 })).resolves.toEqual(['x']);
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '../../../src/domain/role.enum';
import { CreateUserDto } from '../../../src/dto/create-user.dto';

const VALID = {
  email: 'bea@example.com',
  name: 'Bea',
  password: 'correct-horse-battery',
  roles: [Role.ADMIN],
};

/** Validates a raw body as the global pipe does and returns the names of the invalid properties. */
async function invalidProperties(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateUserDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property).sort();
}

describe('CreateUserDto', () => {
  it.each([[[Role.ADMIN]], [[Role.CUSTOMER]]])('should accept roles %p', async (roles) => {
    await expect(invalidProperties({ ...VALID, roles })).resolves.toEqual([]);
  });

  it.each(['email', 'name', 'password', 'roles'])('should reject a missing %s', async (field) => {
    const body: Record<string, unknown> = { ...VALID };
    delete body[field];

    await expect(invalidProperties(body)).resolves.toEqual([field]);
  });

  it.each([
    ['an empty list', []],
    ['an unknown role', ['ROOT']],
    ['a string instead of a list', 'ADMIN'],
    ['a repeated role', [Role.ADMIN, Role.ADMIN]],
    ['both roles', [Role.CUSTOMER, Role.ADMIN]],
    ['null', null],
  ])('should reject roles as %s', async (_label, roles) => {
    await expect(invalidProperties({ ...VALID, roles })).resolves.toEqual(['roles']);
  });

  it.each(['id', 'customerId', 'status', 'createdAt'])(
    'should reject the server-owned field %s',
    async (field) => {
      await expect(invalidProperties({ ...VALID, [field]: 'x' })).resolves.toEqual([field]);
    },
  );

  it.each([
    ['email', ''],
    ['name', 42],
    ['password', ''],
  ])('should reject %s = %p', async (field, value) => {
    await expect(invalidProperties({ ...VALID, [field]: value })).resolves.toEqual([field]);
  });
});

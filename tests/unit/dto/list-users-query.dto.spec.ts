import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { ListUsersQueryDto } from '../../../src/dto/list-users-query.dto';

/** Transforms raw query values as the global pipe does. */
function toDto(query: Record<string, unknown>): ListUsersQueryDto {
  return plainToInstance(ListUsersQueryDto, query);
}

/** Validates raw query values and returns the names of the invalid properties. */
async function invalidProperties(query: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(toDto(query));
  return errors.map((error) => error.property).sort();
}

describe('ListUsersQueryDto', () => {
  it('should default to limit 20 and offset 0 with no filter', async () => {
    const dto = toDto({});

    expect(dto.limit).toBe(20);
    expect(dto.offset).toBe(0);
    expect(dto.role).toBeUndefined();
    expect(dto.status).toBeUndefined();
    expect(dto.email).toBeUndefined();
    await expect(invalidProperties({})).resolves.toEqual([]);
  });

  it('should turn numeric strings into numbers', async () => {
    const dto = toDto({ limit: '50', offset: '10' });

    expect(dto.limit).toBe(50);
    expect(dto.offset).toBe(10);
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each(['1', '100'])('should accept the limit bound %s', async (limit) => {
    await expect(invalidProperties({ limit })).resolves.toEqual([]);
  });

  it.each(['0', '101', '1.5', 'abc', '-1'])('should reject the limit %s', async (limit) => {
    await expect(invalidProperties({ limit })).resolves.toEqual(['limit']);
  });

  it.each(['-1', '0.5', 'abc'])('should reject the offset %s', async (offset) => {
    await expect(invalidProperties({ offset })).resolves.toEqual(['offset']);
  });

  it('should accept the known roles and statuses', async () => {
    await expect(
      invalidProperties({ role: Role.ADMIN, status: UserStatus.DISABLED }),
    ).resolves.toEqual([]);
    await expect(
      invalidProperties({ role: Role.CUSTOMER, status: UserStatus.ACTIVE }),
    ).resolves.toEqual([]);
  });

  it('should reject an unknown role or status', async () => {
    await expect(invalidProperties({ role: 'ROOT', status: 'GONE' })).resolves.toEqual([
      'role',
      'status',
    ]);
  });

  it('should reject a repeated role', async () => {
    await expect(invalidProperties({ role: [Role.ADMIN, Role.CUSTOMER] })).resolves.toEqual([
      'role',
    ]);
  });

  it('should treat an empty email filter as absent', async () => {
    expect(toDto({ email: '' }).email).toBeUndefined();
    await expect(invalidProperties({ email: '' })).resolves.toEqual([]);
  });

  it('should accept an email filter of 254 characters and reject 255', async () => {
    await expect(invalidProperties({ email: 'a'.repeat(254) })).resolves.toEqual([]);
    await expect(invalidProperties({ email: 'a'.repeat(255) })).resolves.toEqual(['email']);
  });
});

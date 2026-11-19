import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { ChangeUserStatusDto } from '../../../src/dto/change-user-status.dto';

/** Validates a raw body as the global pipe does and returns the names of the invalid properties. */
async function invalidProperties(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(ChangeUserStatusDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property).sort();
}

describe('ChangeUserStatusDto', () => {
  it.each([UserStatus.ACTIVE, UserStatus.DISABLED])('should accept %s', async (status) => {
    await expect(invalidProperties({ status })).resolves.toEqual([]);
  });

  it('should reject a missing status', async () => {
    await expect(invalidProperties({})).resolves.toEqual(['status']);
  });

  it.each([['disabled'], ['ENABLED'], [1], [null]])(
    'should reject the status %p',
    async (status) => {
      await expect(invalidProperties({ status })).resolves.toEqual(['status']);
    },
  );

  it('should reject an extra field', async () => {
    await expect(invalidProperties({ status: UserStatus.DISABLED, x: 1 })).resolves.toEqual(['x']);
  });
});

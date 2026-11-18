import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RefreshTokenDto } from '../../../src/dto/refresh-token.dto';

/** Validates a plain body and returns the names of the invalid properties. */
async function invalidProperties(body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(RefreshTokenDto, body));
  return errors.map((error) => error.property).sort();
}

describe('RefreshTokenDto', () => {
  it('should accept a non-empty string', async () => {
    await expect(invalidProperties({ refreshToken: 'a'.repeat(43) })).resolves.toEqual([]);
  });

  it('should accept a token of exactly 512 characters', async () => {
    await expect(invalidProperties({ refreshToken: 'a'.repeat(512) })).resolves.toEqual([]);
  });

  it.each([
    ['missing', {}],
    ['a number', { refreshToken: 42 }],
    ['empty', { refreshToken: '' }],
    ['513 characters', { refreshToken: 'a'.repeat(513) }],
  ])('should reject a refresh token that is %s', async (_case, body) => {
    await expect(invalidProperties(body)).resolves.toEqual(['refreshToken']);
  });
});

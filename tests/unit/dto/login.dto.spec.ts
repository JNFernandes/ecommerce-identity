import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from '../../../src/dto/login.dto';

/** Validates a plain body and returns the names of the invalid properties. */
async function invalidProperties(body: object): Promise<string[]> {
  const errors = await validate(plainToInstance(LoginDto, body));
  return errors.map((error) => error.property).sort();
}

describe('LoginDto', () => {
  it('should accept two non-empty strings', async () => {
    await expect(
      invalidProperties({ email: 'ana@example.com', password: 'correct-horse' }),
    ).resolves.toEqual([]);
  });

  it('should accept a short password, since no policy applies at login', async () => {
    await expect(invalidProperties({ email: 'ana@example.com', password: 'x' })).resolves.toEqual(
      [],
    );
  });

  it('should keep surrounding spaces in the password', () => {
    const dto = plainToInstance(LoginDto, { email: 'a@b.co', password: ' secret ' });

    expect(dto.password).toBe(' secret ');
  });

  it('should reject missing fields', async () => {
    await expect(invalidProperties({})).resolves.toEqual(['email', 'password']);
  });

  it('should reject non-string values', async () => {
    await expect(invalidProperties({ email: 42, password: ['secret'] })).resolves.toEqual([
      'email',
      'password',
    ]);
  });

  it('should reject empty strings', async () => {
    await expect(invalidProperties({ email: '', password: '' })).resolves.toEqual([
      'email',
      'password',
    ]);
  });
});

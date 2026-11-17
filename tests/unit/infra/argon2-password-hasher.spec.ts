import { ConfigService } from '@nestjs/config';
import { verify } from 'argon2';
import { Argon2Config } from '../../../src/config/configuration';
import { Argon2PasswordHasher } from '../../../src/infra/security/argon2-password-hasher';

describe('Argon2PasswordHasher', () => {
  const argon2: Argon2Config = { memoryCostKib: 1024, timeCost: 2, parallelism: 1 };
  const hasher = new Argon2PasswordHasher(new ConfigService({ argon2 }));
  const password = 'correct horse battery staple';

  it('should produce an argon2id hash', async () => {
    await expect(hasher.hash(password)).resolves.toMatch(/^\$argon2id\$/);
  });

  it('should encode the configured parameters', async () => {
    const encoded = await hasher.hash(password);

    expect(encoded).toContain('$m=1024,t=2,p=1$');
  });

  it('should produce a hash that verifies against the password', async () => {
    const encoded = await hasher.hash(password);

    await expect(verify(encoded, password)).resolves.toBe(true);
    await expect(verify(encoded, 'another password')).resolves.toBe(false);
  });

  it('should salt every hash, so two hashes of one password differ', async () => {
    const [first, second] = await Promise.all([hasher.hash(password), hasher.hash(password)]);

    expect(first).not.toBe(second);
  });

  it('should not contain the plain password', async () => {
    await expect(hasher.hash(password)).resolves.not.toContain(password);
  });

  it('should fail fast when the argon2 configuration is missing', () => {
    expect(() => new Argon2PasswordHasher(new ConfigService({}))).toThrow();
  });
});

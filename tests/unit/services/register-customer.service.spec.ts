import { RegisterCustomerCommand } from '../../../src/commands/register-customer.command';
import { DuplicateEmailError } from '../../../src/domain/errors/duplicate-email.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { UserRepository } from '../../../src/repositories/user.repository';
import { PasswordHasher } from '../../../src/services/ports/password-hasher';
import { RegisterCustomerService } from '../../../src/services/register-customer.service';

const HASH = '$argon2id$v=19$m=1024,t=2,p=1$salt$digest';
const PASSWORD = 'correct-horse-battery';

describe('RegisterCustomerService', () => {
  let hash: jest.Mock<Promise<string>, [string]>;
  let save: jest.Mock<Promise<void>, [User]>;
  let service: RegisterCustomerService;

  beforeEach(() => {
    hash = jest.fn<Promise<string>, [string]>().mockResolvedValue(HASH);
    save = jest.fn<Promise<void>, [User]>().mockResolvedValue(undefined);
    service = new RegisterCustomerService(
      { hash } as PasswordHasher,
      { save } as unknown as UserRepository,
    );
  });

  it('should hash the plain password exactly once', async () => {
    await service.execute(new RegisterCustomerCommand('ana@example.com', 'Ana', PASSWORD));

    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith(PASSWORD);
  });

  it('should save and return an ACTIVE customer holding the hash', async () => {
    const user = await service.execute(
      new RegisterCustomerCommand(' Ana@Example.com ', ' Ana ', PASSWORD),
    );

    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0];
    expect(saved).toBe(user);
    expect(saved.roles).toEqual([Role.CUSTOMER]);
    expect(saved.status).toBe(UserStatus.ACTIVE);
    expect(saved.passwordHash).toBe(HASH);
    expect(saved.email.value).toBe('ana@example.com');
    expect(saved.name.value).toBe('Ana');
  });

  it.each([
    ['an invalid email', 'not-an-email', 'Ana', PASSWORD],
    ['an empty name', 'ana@example.com', '   ', PASSWORD],
    ['a short password', 'ana@example.com', 'Ana', 'short'],
    ['a password equal to the email', 'ana@example.com', 'Ana', ' ANA@example.com '],
  ])('should reject %s without hashing or saving', async (_case, email, name, password) => {
    await expect(
      service.execute(new RegisterCustomerCommand(email, name, password)),
    ).rejects.toBeInstanceOf(UserValidationError);
    expect(hash).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('should propagate DuplicateEmailError from save', async () => {
    save.mockRejectedValue(new DuplicateEmailError());

    await expect(
      service.execute(new RegisterCustomerCommand('ana@example.com', 'Ana', PASSWORD)),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });
});

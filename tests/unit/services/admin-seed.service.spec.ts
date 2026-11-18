import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminSeedConfig } from '../../../src/config/configuration';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { UserRepository } from '../../../src/repositories/user.repository';
import { AdminSeedService } from '../../../src/services/admin-seed.service';
import { PasswordHasher } from '../../../src/services/ports/password-hasher';
import { UserEventPublisher } from '../../../src/services/ports/user-event-publisher';

const HASH = '$argon2id$v=19$m=1024,t=2,p=1$salt$digest';
const PASSWORD = 'change-me-now-123';

describe('AdminSeedService', () => {
  let config: AdminSeedConfig;
  let existsWithRole: jest.Mock<Promise<boolean>, [Role]>;
  let findByEmail: jest.Mock<Promise<User | null>, [string]>;
  let save: jest.Mock<Promise<void>, [User]>;
  let hash: jest.Mock<Promise<string>, [string]>;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let service: AdminSeedService;

  beforeEach(() => {
    config = { email: 'Admin@Example.com', password: PASSWORD, name: 'Administrator' };
    existsWithRole = jest.fn<Promise<boolean>, [Role]>().mockResolvedValue(false);
    findByEmail = jest.fn<Promise<User | null>, [string]>().mockResolvedValue(null);
    save = jest.fn<Promise<void>, [User]>().mockResolvedValue(undefined);
    hash = jest.fn<Promise<string>, [string]>().mockResolvedValue(HASH);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    service = new AdminSeedService(
      { getOrThrow: () => config } as unknown as ConfigService,
      { existsWithRole, findByEmail, save } as unknown as UserRepository,
      { hash, verify: jest.fn(), dummyHash: jest.fn() } as PasswordHasher,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Every argument passed to any log level, as text. */
  function loggedText(): string {
    return [log, warn, error]
      .flatMap((spy) => spy.mock.calls)
      .map((call: unknown[]) => call.map(String).join(' '))
      .join('\n');
  }

  it('should create an ACTIVE admin without a customerId, holding the hash', async () => {
    await service.onApplicationBootstrap();

    expect(existsWithRole).toHaveBeenCalledWith(Role.ADMIN);
    expect(findByEmail).toHaveBeenCalledWith('admin@example.com');
    expect(hash).toHaveBeenCalledWith(PASSWORD);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0];
    expect(saved.roles).toEqual([Role.ADMIN]);
    expect(saved.status).toBe(UserStatus.ACTIVE);
    expect(saved.customerId).toBeNull();
    expect(saved.email.value).toBe('admin@example.com');
    expect(saved.name.value).toBe('Administrator');
    expect(saved.passwordHash).toBe(HASH);
    expect(saved.pullDomainEvents()).toEqual([]);
  });

  it('should log the new admin id, never the email or the password', async () => {
    await service.seed();

    const saved = save.mock.calls[0][0];
    expect(log).toHaveBeenCalledWith(expect.stringContaining(saved.id));
    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain('admin@example.com');
  });

  it('should do nothing, silently, when an admin already exists', async () => {
    existsWithRole.mockResolvedValue(true);

    await service.seed();

    expect(findByEmail).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('should stay silent when an admin exists and the variables are missing', async () => {
    existsWithRole.mockResolvedValue(true);
    config = { email: undefined, password: undefined, name: 'Administrator' };

    await service.seed();

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN_EMAIL', { email: undefined, password: PASSWORD }],
    ['ADMIN_PASSWORD', { email: 'admin@example.com', password: undefined }],
    ['both variables', { email: undefined, password: undefined }],
  ])(
    'should warn and save nothing when %s is missing and no admin exists',
    async (_case, values) => {
      config = { ...values, name: 'Administrator' };

      await service.seed();

      expect(warn).toHaveBeenCalledWith(
        'No administrator exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set',
      );
      expect(findByEmail).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it('should not depend on the event publisher', () => {
    const parameters: unknown[] =
      (Reflect.getMetadata('design:paramtypes', AdminSeedService) as unknown[] | undefined) ?? [];

    expect(parameters).not.toContain(UserEventPublisher);
    expect(parameters).toEqual([ConfigService, UserRepository, PasswordHasher]);
  });

  it('should propagate a repository error from existsWithRole', async () => {
    existsWithRole.mockRejectedValue(new Error('connection refused'));

    await expect(service.seed()).rejects.toThrow('connection refused');
  });

  it('should propagate a repository error from save', async () => {
    save.mockRejectedValue(new Error('connection reset'));

    await expect(service.seed()).rejects.toThrow('connection reset');
  });
});

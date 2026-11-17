import { Logger } from '@nestjs/common';
import { RegisterCustomerCommand } from '../../../src/commands/register-customer.command';
import { DuplicateEmailError } from '../../../src/domain/errors/duplicate-email.error';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';
import { UserRegistered } from '../../../src/domain/events/user-registered.event';
import { Role } from '../../../src/domain/role.enum';
import { User } from '../../../src/domain/user.aggregate';
import { UserStatus } from '../../../src/domain/user-status.enum';
import {
  FailedPublish,
  OutboundDeadLetterRepository,
} from '../../../src/repositories/outbound-dead-letter.repository';
import { UserRepository } from '../../../src/repositories/user.repository';
import { PasswordHasher } from '../../../src/services/ports/password-hasher';
import { UserEventPublisher } from '../../../src/services/ports/user-event-publisher';
import { RegisterCustomerService } from '../../../src/services/register-customer.service';

const HASH = '$argon2id$v=19$m=1024,t=2,p=1$salt$digest';
const PASSWORD = 'correct-horse-battery';

describe('RegisterCustomerService', () => {
  let hash: jest.Mock<Promise<string>, [string]>;
  let save: jest.Mock<Promise<void>, [User]>;
  let publishUserRegistered: jest.Mock<Promise<void>, [UserRegistered]>;
  let recordFailure: jest.Mock<Promise<void>, [FailedPublish]>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let service: RegisterCustomerService;

  const command = (): RegisterCustomerCommand =>
    new RegisterCustomerCommand('ana@example.com', 'Ana', PASSWORD);

  beforeEach(() => {
    hash = jest.fn<Promise<string>, [string]>().mockResolvedValue(HASH);
    save = jest.fn<Promise<void>, [User]>().mockResolvedValue(undefined);
    publishUserRegistered = jest.fn<Promise<void>, [UserRegistered]>().mockResolvedValue(undefined);
    recordFailure = jest.fn<Promise<void>, [FailedPublish]>().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new RegisterCustomerService(
      { hash } as PasswordHasher,
      { save } as unknown as UserRepository,
      { publishUserRegistered } as UserEventPublisher,
      { recordFailure } as unknown as OutboundDeadLetterRepository,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('should propagate DuplicateEmailError from save without publishing', async () => {
    save.mockRejectedValue(new DuplicateEmailError());

    await expect(service.execute(command())).rejects.toBeInstanceOf(DuplicateEmailError);
    expect(publishUserRegistered).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('should neither publish nor dead-letter when save fails', async () => {
    save.mockRejectedValue(new Error('db down'));

    await expect(service.execute(command())).rejects.toThrow('db down');
    expect(publishUserRegistered).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('should publish UserRegistered for the saved user after save', async () => {
    const user = await service.execute(command());

    expect(publishUserRegistered).toHaveBeenCalledTimes(1);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      publishUserRegistered.mock.invocationCallOrder[0],
    );
    const event = publishUserRegistered.mock.calls[0][0];
    expect(event).toBeInstanceOf(UserRegistered);
    expect(event.aggregateId).toBe(user.id);
    expect(event.customerId).toBe(user.customerId);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('should dead-letter a failed publish with the same eventId, log it and still succeed', async () => {
    publishUserRegistered.mockRejectedValue(new Error('broker down'));

    const user = await service.execute(command());

    expect(user).toBeInstanceOf(User);
    const event = publishUserRegistered.mock.calls[0][0];
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith({
      eventId: event.eventId,
      topic: 'identity.user-registered',
      key: user.id,
      payload: {
        eventId: event.eventId,
        aggregateId: user.id,
        occurredAt: event.occurredAt,
        version: 1,
        customerId: user.customerId,
        email: 'ana@example.com',
        name: 'Ana',
      },
      error: 'broker down',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    for (const part of [
      'identity.user-registered',
      `key=${user.id}`,
      `eventId=${event.eventId}`,
      `aggregateId=${user.id}`,
      'broker down',
    ]) {
      expect(line).toContain(part);
    }
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(HASH);
  });

  it('should still succeed and log an error when dead-lettering also fails', async () => {
    publishUserRegistered.mockRejectedValue(new Error('broker down'));
    recordFailure.mockRejectedValue(new Error('db down'));

    await expect(service.execute(command())).resolves.toBeInstanceOf(User);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('db down');
  });
});

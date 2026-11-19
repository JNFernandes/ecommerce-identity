import { Logger } from '@nestjs/common';
import { Email } from '../../../src/domain/email.value-object';
import { UserRegistered } from '../../../src/domain/events/user-registered.event';
import { User } from '../../../src/domain/user.aggregate';
import { UserName } from '../../../src/domain/user-name.value-object';
import {
  FailedPublish,
  OutboundDeadLetterRepository,
} from '../../../src/repositories/outbound-dead-letter.repository';
import { UserEventPublisher } from '../../../src/services/ports/user-event-publisher';
import { UserEventDispatcher } from '../../../src/services/user-event-dispatcher';

const HASH = '$argon2id$v=19$m=1024,t=2,p=1$salt$digest';

function customer(): User {
  return User.registerCustomer(Email.create('ana@example.com'), UserName.create('Ana'), HASH);
}

describe('UserEventDispatcher', () => {
  let publishUserRegistered: jest.Mock<Promise<void>, [UserRegistered]>;
  let recordFailure: jest.Mock<Promise<void>, [FailedPublish]>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let dispatcher: UserEventDispatcher;

  beforeEach(() => {
    publishUserRegistered = jest.fn<Promise<void>, [UserRegistered]>().mockResolvedValue(undefined);
    recordFailure = jest.fn<Promise<void>, [FailedPublish]>().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    dispatcher = new UserEventDispatcher(
      { publishUserRegistered, republish: jest.fn() } as UserEventPublisher,
      { recordFailure } as unknown as OutboundDeadLetterRepository,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should publish each recorded event once and nothing else', async () => {
    const user = customer();

    await dispatcher.dispatch(user);

    expect(publishUserRegistered).toHaveBeenCalledTimes(1);
    expect(publishUserRegistered.mock.calls[0][0].aggregateId).toBe(user.id);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('should not publish the same events twice', async () => {
    const user = customer();

    await dispatcher.dispatch(user);
    await dispatcher.dispatch(user);

    expect(publishUserRegistered).toHaveBeenCalledTimes(1);
  });

  it('should do nothing for a user without events', async () => {
    const admin = User.registerAdmin(Email.create('bea@example.com'), UserName.create('Bea'), HASH);

    await dispatcher.dispatch(admin);

    expect(publishUserRegistered).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('should log and dead-letter a failed publish with the exact payload, without throwing', async () => {
    const user = customer();
    publishUserRegistered.mockRejectedValue(new Error('broker down'));

    await expect(dispatcher.dispatch(user)).resolves.toBeUndefined();

    const event = publishUserRegistered.mock.calls[0][0];
    expect(recordFailure).toHaveBeenCalledWith({
      eventId: event.eventId,
      topic: 'identity.user-registered',
      key: user.id,
      payload: { ...event },
      error: 'broker down',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`eventId=${event.eventId}`);
    expect(String(warn.mock.calls[0][0])).not.toContain(HASH);
  });

  it('should log an error and not throw when dead-lettering fails too', async () => {
    publishUserRegistered.mockRejectedValue(new Error('broker down'));
    recordFailure.mockRejectedValue(new Error('db down'));

    await expect(dispatcher.dispatch(customer())).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('db down');
  });
});

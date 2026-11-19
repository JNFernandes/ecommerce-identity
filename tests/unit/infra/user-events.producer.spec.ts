import { UserRegistered } from '../../../src/domain/events/user-registered.event';
import { LazyKafkaProducer } from '../../../src/infra/kafka/lazy-kafka-producer';
import { UserEventsProducer } from '../../../src/infra/kafka/user-events.producer';

describe('UserEventsProducer', () => {
  const event = new UserRegistered({
    aggregateId: '7d6f2c1e-0000-4000-8000-000000000001',
    customerId: '1b2c3d4e-0000-4000-8000-000000000002',
    email: 'ana@example.com',
    name: 'Ana',
    occurredAt: new Date('2026-11-17T12:00:00.000Z'),
  });
  let publish: jest.Mock<Promise<void>, Parameters<LazyKafkaProducer['publish']>>;
  let publishRaw: jest.Mock<Promise<void>, Parameters<LazyKafkaProducer['publishRaw']>>;
  let producer: UserEventsProducer;

  beforeEach(() => {
    publish = jest.fn().mockResolvedValue(undefined);
    publishRaw = jest.fn().mockResolvedValue(undefined);
    producer = new UserEventsProducer({ publish, publishRaw } as unknown as LazyKafkaProducer);
  });

  describe('republish', () => {
    const payload = { eventId: 'e-1', aggregateId: 'u-1', email: 'ana@example.com' };

    it('should delegate the stored topic, key and payload unchanged', async () => {
      await producer.republish('identity.user-registered', 'stored-key', payload);

      expect(publishRaw).toHaveBeenCalledWith('identity.user-registered', 'stored-key', payload);
      expect(publish).not.toHaveBeenCalled();
    });

    it('should propagate a publish failure', async () => {
      const failure = new Error('broker down');
      publishRaw.mockRejectedValue(failure);

      await expect(producer.republish('identity.user-registered', 'k', payload)).rejects.toBe(
        failure,
      );
    });
  });

  it('should publish on identity.user-registered with exactly the seven contract fields', async () => {
    await producer.publishUserRegistered(event);

    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, payload] = publish.mock.calls[0];
    expect(topic).toBe('identity.user-registered');
    expect(payload).toEqual({
      eventId: event.eventId,
      aggregateId: '7d6f2c1e-0000-4000-8000-000000000001',
      occurredAt: '2026-11-17T12:00:00.000Z',
      version: 1,
      customerId: '1b2c3d4e-0000-4000-8000-000000000002',
      email: 'ana@example.com',
      name: 'Ana',
    });
  });

  it('should key the message by the aggregateId', async () => {
    await producer.publishUserRegistered(event);

    expect(publish.mock.calls[0][1].aggregateId).toBe(event.aggregateId);
  });

  it('should propagate a publish failure', async () => {
    const failure = new Error('broker down');
    publish.mockRejectedValue(failure);

    await expect(producer.publishUserRegistered(event)).rejects.toBe(failure);
  });
});

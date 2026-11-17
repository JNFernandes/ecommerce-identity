import { Logger } from '@nestjs/common';
import { Producer } from 'kafkajs';
import { EventEnvelope, LazyKafkaProducer } from '../../../src/infra/kafka/lazy-kafka-producer';
import { KafkaProducerState } from '../../../src/infra/kafka/kafka-producer-state.enum';

const TOPIC = 'identity.test-topic';
const event: EventEnvelope = {
  eventId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  aggregateId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  occurredAt: '2026-11-17T12:00:00.000Z',
  version: 1,
};

describe('LazyKafkaProducer', () => {
  let send: jest.Mock;
  let connect: jest.Mock;
  let disconnect: jest.Mock;
  let producer: LazyKafkaProducer;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    send = jest.fn().mockResolvedValue([]);
    connect = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn().mockResolvedValue(undefined);
    producer = new LazyKafkaProducer({ send, connect, disconnect } as unknown as Producer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should not connect at construction and report the idle state', () => {
    expect(connect).not.toHaveBeenCalled();
    expect(producer.state).toBe(KafkaProducerState.IDLE);
  });

  it('should connect on the first publish and send the event as JSON keyed by aggregateId', async () => {
    await producer.publish(TOPIC, event);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(send).toHaveBeenCalledWith({
      topic: TOPIC,
      messages: [{ key: event.aggregateId, value: JSON.stringify(event) }],
    });
    expect(producer.state).toBe(KafkaProducerState.CONNECTED);
  });

  it('should share one connection attempt between concurrent publishes and reuse it', async () => {
    let finishConnect: () => void = () => undefined;
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConnect = resolve;
        }),
    );

    const first = producer.publish(TOPIC, event);
    const second = producer.publish(TOPIC, event);
    finishConnect();
    await Promise.all([first, second]);
    await producer.publish(TOPIC, event);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('should propagate a failed connect without sending, then try again on the next publish', async () => {
    connect.mockRejectedValueOnce(new Error('broker down'));

    await expect(producer.publish(TOPIC, event)).rejects.toThrow('broker down');
    expect(send).not.toHaveBeenCalled();
    expect(producer.state).toBe(KafkaProducerState.UNAVAILABLE);

    await producer.publish(TOPIC, event);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(producer.state).toBe(KafkaProducerState.CONNECTED);
  });

  it('should propagate send errors', async () => {
    send.mockRejectedValue(new Error('send failed'));

    await expect(producer.publish(TOPIC, event)).rejects.toThrow('send failed');
  });

  it('should not disconnect on shutdown when it never connected', async () => {
    await producer.onApplicationShutdown();

    expect(disconnect).not.toHaveBeenCalled();
  });

  it('should not disconnect on shutdown when the only connection attempt failed', async () => {
    connect.mockRejectedValueOnce(new Error('broker down'));
    await expect(producer.publish(TOPIC, event)).rejects.toThrow('broker down');

    await producer.onApplicationShutdown();

    expect(disconnect).not.toHaveBeenCalled();
  });

  it('should disconnect on shutdown after a successful connection', async () => {
    await producer.publish(TOPIC, event);

    await producer.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(producer.state).toBe(KafkaProducerState.IDLE);
  });
});

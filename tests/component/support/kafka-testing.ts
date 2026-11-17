import { Admin, Consumer, Kafka } from 'kafkajs';

type CreateTopicsOptions = Parameters<Admin['createTopics']>[0];

/**
 * `admin.createTopics`, retried until the Kafka test container is ready (copied from
 * ecommerce-orders).
 *
 * A freshly started KafkaContainer accepts connections before its controller is elected; under
 * load `createTopics` then fails with `KafkaJSBrokerNotFound`. Retrying until the controller
 * answers (or the timeout expires) makes topic setup deterministic. Existing topics are skipped.
 */
export async function createTopicsWhenReady(
  admin: Admin,
  options: CreateTopicsOptions,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await admin.createTopics(options);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** A message read by `TopicObserver`. */
export interface ObservedMessage {
  key: string | null;
  value: Record<string, unknown>;
}

/** Reads every message of one topic from the beginning, for assertions in component tests. */
export class TopicObserver {
  /** Messages received so far, in arrival order. */
  readonly messages: ObservedMessage[] = [];

  private constructor(
    private readonly consumer: Consumer,
    private readonly topic: string,
  ) {}

  /**
   * Creates the topic (1 partition) and starts consuming it from the beginning.
   *
   * @param broker The test container's broker address.
   * @param topic The topic to observe.
   */
  static async start(broker: string, topic: string): Promise<TopicObserver> {
    const kafka = new Kafka({ clientId: 'test-observer', brokers: [broker] });
    const admin = kafka.admin();
    await admin.connect();
    await createTopicsWhenReady(admin, { topics: [{ topic, numPartitions: 1 }] });
    await admin.disconnect();

    const observer = new TopicObserver(
      kafka.consumer({ groupId: `test-observer-${topic}` }),
      topic,
    );
    await observer.consumer.connect();
    await observer.consumer.subscribe({ topic, fromBeginning: true });
    await observer.consumer.run({
      eachMessage: async ({ message }) => {
        if (message.value === null) {
          return;
        }
        observer.messages.push({
          key: message.key?.toString() ?? null,
          value: JSON.parse(message.value.toString()) as Record<string, unknown>,
        });
      },
    });
    return observer;
  }

  /**
   * Waits until at least `count` messages arrived, then `settleMs` more so that extra messages
   * would show up too. Rejects after `timeoutMs`.
   */
  async waitForMessages(count: number, timeoutMs = 30_000, settleMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `expected ${count} message(s) on ${this.topic}, got ${this.messages.length}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  /** Stops consuming. */
  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}

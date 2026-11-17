import { UserRegistered } from '../../../src/domain/events/user-registered.event';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UserRegistered', () => {
  const data = {
    aggregateId: '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b',
    customerId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70',
    email: 'ana@example.com',
    name: 'Ana Silva',
    occurredAt: new Date('2026-11-17T13:00:00.000Z'),
  };

  it('should have exactly the 7 payload fields', () => {
    const event = new UserRegistered(data);

    expect(Object.keys(event).sort()).toEqual(
      ['aggregateId', 'customerId', 'email', 'eventId', 'name', 'occurredAt', 'version'].sort(),
    );
  });

  it('should copy the data, format occurredAt as ISO 8601 and use version 1', () => {
    const event = new UserRegistered(data);

    expect(event).toEqual({
      eventId: expect.stringMatching(UUID),
      aggregateId: data.aggregateId,
      occurredAt: '2026-11-17T13:00:00.000Z',
      version: 1,
      customerId: data.customerId,
      email: data.email,
      name: data.name,
    });
  });

  it('should give every event a new eventId', () => {
    expect(new UserRegistered(data).eventId).not.toBe(new UserRegistered(data).eventId);
  });
});

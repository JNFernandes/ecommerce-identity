import { Role } from '../../../src/domain/role.enum';
import { UserStatus } from '../../../src/domain/user-status.enum';
import { UserPageResponseDto } from '../../../src/dto/user-page-response.dto';
import { UserSummaryResponseDto } from '../../../src/dto/user-summary-response.dto';
import { UserSummaryReadModel } from '../../../src/queries/user-summary.read-model';

const CREATED_AT = new Date('2026-11-18T10:00:00.000Z');
const LOGIN_AT = new Date('2026-11-18T11:00:00.000Z');

function customer(): UserSummaryReadModel {
  return {
    id: '6f1c2a5e-0000-4000-8000-000000000001',
    customerId: 'a2d4b7c9-0000-4000-8000-000000000002',
    email: 'ana@example.com',
    name: 'Ana',
    roles: [Role.CUSTOMER],
    status: UserStatus.ACTIVE,
    createdAt: CREATED_AT,
    lastLoginAt: LOGIN_AT,
  };
}

/** The JSON the client receives. */
function json(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe('UserSummaryResponseDto', () => {
  it('should carry exactly the eight public fields for a customer', () => {
    expect(json(UserSummaryResponseDto.from(customer()))).toEqual({
      id: '6f1c2a5e-0000-4000-8000-000000000001',
      customerId: 'a2d4b7c9-0000-4000-8000-000000000002',
      email: 'ana@example.com',
      name: 'Ana',
      roles: ['CUSTOMER'],
      status: 'ACTIVE',
      createdAt: '2026-11-18T10:00:00.000Z',
      lastLoginAt: '2026-11-18T11:00:00.000Z',
    });
  });

  it('should leave customerId out for a user without one', () => {
    const body = json(
      UserSummaryResponseDto.from({ ...customer(), customerId: null, roles: [Role.ADMIN] }),
    );

    expect(body).not.toHaveProperty('customerId');
    expect(Object.keys(body)).toHaveLength(7);
  });

  it('should keep lastLoginAt as null when the user never logged in', () => {
    const body = json(UserSummaryResponseDto.from({ ...customer(), lastLoginAt: null }));

    expect(body).toHaveProperty('lastLoginAt', null);
  });

  it('should never carry a password, hash or updatedAt, even if the source has them', () => {
    const leaky = { ...customer(), passwordHash: '$argon2id$x', updatedAt: CREATED_AT };

    const body = json(UserSummaryResponseDto.from(leaky));

    for (const key of ['password', 'passwordHash', 'updatedAt']) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe('UserPageResponseDto', () => {
  it('should map every item and keep total, limit and offset', () => {
    const page = UserPageResponseDto.from({
      items: [customer(), { ...customer(), id: 'other', customerId: null }],
      total: 42,
      limit: 2,
      offset: 4,
    });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toBeInstanceOf(UserSummaryResponseDto);
    expect(json(page.items[1])).not.toHaveProperty('customerId');
    expect(page).toMatchObject({ total: 42, limit: 2, offset: 4 });
  });

  it('should return an empty page with the real total', () => {
    expect(json(UserPageResponseDto.from({ items: [], total: 3, limit: 20, offset: 40 }))).toEqual({
      items: [],
      total: 3,
      limit: 20,
      offset: 40,
    });
  });
});

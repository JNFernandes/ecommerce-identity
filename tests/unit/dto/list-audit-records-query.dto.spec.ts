import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditAction } from '../../../src/domain/audit/audit-action.enum';
import { ListAuditRecordsQueryDto } from '../../../src/dto/list-audit-records-query.dto';

const UUID = '00000000-0000-4000-8000-00000000000a';

/** Transforms raw query values as the global pipe does. */
function toDto(query: Record<string, unknown>): ListAuditRecordsQueryDto {
  return plainToInstance(ListAuditRecordsQueryDto, query);
}

/** Validates raw query values and returns the names of the invalid properties. */
async function invalidProperties(query: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(toDto(query));
  return errors.map((error) => error.property).sort();
}

describe('ListAuditRecordsQueryDto', () => {
  it('should default to limit 20 and offset 0 with no filter', async () => {
    const dto = toDto({});

    expect(dto).toMatchObject({ limit: 20, offset: 0 });
    expect(dto.actorId).toBeUndefined();
    expect(dto.targetId).toBeUndefined();
    expect(dto.action).toBeUndefined();
    await expect(invalidProperties({})).resolves.toEqual([]);
  });

  it('should accept the bounds and every filter', async () => {
    await expect(
      invalidProperties({
        limit: '100',
        offset: '0',
        actorId: UUID,
        targetId: UUID,
        action: AuditAction.USER_STATUS_CHANGED,
      }),
    ).resolves.toEqual([]);
    await expect(invalidProperties({ limit: '1' })).resolves.toEqual([]);
  });

  it.each(['0', '101', '-1', '1.5', 'abc'])('should reject the limit %s', async (limit) => {
    await expect(invalidProperties({ limit })).resolves.toEqual(['limit']);
  });

  it.each(['-1', '1.5'])('should reject the offset %s', async (offset) => {
    await expect(invalidProperties({ offset })).resolves.toEqual(['offset']);
  });

  it('should reject ids that are not UUIDs and an unknown action', async () => {
    await expect(
      invalidProperties({ actorId: 'abc', targetId: '123', action: 'USER_DELETED' }),
    ).resolves.toEqual(['action', 'actorId', 'targetId']);
  });

  it('should reject repeated parameters', async () => {
    await expect(
      invalidProperties({
        limit: ['1', '2'],
        actorId: [UUID, UUID],
        action: [AuditAction.USER_CREATED, AuditAction.ROLES_CHANGED],
      }),
    ).resolves.toEqual(['action', 'actorId', 'limit']);
  });
});

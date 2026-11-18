import { Logger } from '@nestjs/common';
import { LogoutCommand } from '../../../src/commands/logout.command';
import { RefreshToken } from '../../../src/domain/refresh-token.aggregate';
import {
  RefreshTokenRepository,
  RefreshTokenTx,
} from '../../../src/repositories/refresh-token.repository';
import { LogoutService } from '../../../src/services/logout.service';
import { Clock } from '../../../src/services/ports/clock';
import { RefreshTokenGenerator } from '../../../src/services/ports/refresh-token-generator';

const PRESENTED = 'presented-refresh-value';
const PRESENTED_HASH = 'p'.repeat(64);
const NOW = new Date('2026-11-05T00:00:00.000Z');
const FAMILY_ID = '0b9d7c1e-3f4a-4c2b-8e6d-5a1f2b3c4d5e';
const USER_ID = '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b';
const IP = '203.0.113.7';

describe('LogoutService', () => {
  let stored: RefreshToken | null;
  let calls: string[];
  let revokeFamily: jest.Mock<Promise<number>, [string, Date]>;
  let log: jest.SpyInstance;
  let service: LogoutService;

  beforeEach(() => {
    stored = RefreshToken.restore({
      id: '1d2c3b4a-5e6f-4a1b-9c2d-3e4f5a6b7c8d',
      userId: USER_ID,
      familyId: FAMILY_ID,
      tokenHash: PRESENTED_HASH,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      expiresAt: new Date('2026-11-08T00:00:00.000Z'),
      revokedAt: null,
      replacedBy: null,
    });
    calls = [];
    revokeFamily = jest.fn<Promise<number>, [string, Date]>().mockImplementation(() => {
      calls.push('revokeFamily');
      return Promise.resolve(1);
    });
    const tx = {
      findByHash: (hash: string) => {
        calls.push('findByHash');
        return Promise.resolve(hash === PRESENTED_HASH ? stored : null);
      },
      lockFamily: () => {
        calls.push('lockFamily');
        return Promise.resolve();
      },
      revokeFamily,
    } as unknown as RefreshTokenTx;
    const repository = {
      inTransaction: <T>(work: (t: RefreshTokenTx) => Promise<T>): Promise<T> => work(tx),
    } as unknown as RefreshTokenRepository;
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new LogoutService(
      repository,
      {
        generate: jest.fn(),
        hash: (value: string) => (value === PRESENTED ? PRESENTED_HASH : 'u'.repeat(64)),
      } as RefreshTokenGenerator,
      { now: () => NOW } as Clock,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should take the family lock, then revoke the whole family of a known token', async () => {
    await expect(service.execute(new LogoutCommand(PRESENTED, IP))).resolves.toBeUndefined();

    expect(calls).toEqual(['findByHash', 'lockFamily', 'revokeFamily']);
    expect(revokeFamily).toHaveBeenCalledWith(FAMILY_ID, NOW);
    expect(log).toHaveBeenCalledWith(`logout: userId=${USER_ID} familyId=${FAMILY_ID} ip=${IP}`);
  });

  it('should touch nothing for an unknown token', async () => {
    await expect(service.execute(new LogoutCommand('never-issued', IP))).resolves.toBeUndefined();

    expect(calls).toEqual(['findByHash']);
    expect(revokeFamily).not.toHaveBeenCalled();
  });

  it('should never log the token or its hash', async () => {
    await service.execute(new LogoutCommand(PRESENTED, IP));
    await service.execute(new LogoutCommand('never-issued', IP));

    const lines = JSON.stringify(log.mock.calls);
    expect(lines).not.toContain(PRESENTED);
    expect(lines).not.toContain(PRESENTED_HASH);
    expect(lines).not.toContain('never-issued');
  });

  it('should propagate a repository error', async () => {
    const failure = new Error('database down');
    revokeFamily.mockRejectedValue(failure);

    await expect(service.execute(new LogoutCommand(PRESENTED, IP))).rejects.toBe(failure);
  });
});

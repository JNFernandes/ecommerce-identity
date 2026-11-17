import { LoginResponseDto } from '../../../src/dto/login-response.dto';
import { LoginResult } from '../../../src/services/login.service';

describe('LoginResponseDto.fromResult', () => {
  const result: LoginResult = {
    accessToken: 'signed.access.token',
    refreshToken: 'opaque-refresh',
    tokenType: 'Bearer',
    expiresIn: 900,
  };

  it('should return exactly the four fields with the result values', () => {
    const dto = LoginResponseDto.fromResult(result);

    expect(dto).toBeInstanceOf(LoginResponseDto);
    expect(Object.keys(dto).sort()).toEqual(
      ['accessToken', 'expiresIn', 'refreshToken', 'tokenType'].sort(),
    );
    expect({ ...dto }).toEqual(result);
  });

  it('should drop any extra property of the result', () => {
    const extra = { ...result, userId: 'not-public' } as LoginResult;

    expect(LoginResponseDto.fromResult(extra)).not.toHaveProperty('userId');
  });
});

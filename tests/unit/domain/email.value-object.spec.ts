import { Email } from '../../../src/domain/email.value-object';
import { UserValidationError } from '../../../src/domain/errors/user-validation.error';

/** Builds a valid address of exactly `length` characters. */
function emailOfLength(length: number): string {
  const domain = '@example.com';
  return 'a'.repeat(length - domain.length) + domain;
}

describe('Email.normalize', () => {
  it('should trim and lowercase without validating', () => {
    expect(Email.normalize(' Ana@Example.com ')).toBe('ana@example.com');
    expect(Email.normalize(' Not An Email ')).toBe('not an email');
  });
});

describe('Email', () => {
  it('should trim and lowercase the address', () => {
    expect(Email.create(' Ana@Example.com ').value).toBe('ana@example.com');
  });

  it('should accept a sub-domain', () => {
    expect(Email.create('ana@mail.example.co.uk').value).toBe('ana@mail.example.co.uk');
  });

  it.each([
    '',
    '   ',
    'ana',
    'ana@',
    '@example.com',
    'ana@example',
    'ana@@example.com',
    'ana@exa mple.com',
    'an a@example.com',
    'ana@example.',
    'ana@.com',
    'ana@example..com',
  ])('should reject %p', (raw) => {
    expect(() => Email.create(raw)).toThrow(UserValidationError);
  });

  it('should accept 254 characters', () => {
    const raw = emailOfLength(254);

    expect(Email.create(raw).value).toHaveLength(254);
  });

  it('should reject 255 characters', () => {
    expect(() => Email.create(emailOfLength(255))).toThrow(UserValidationError);
  });

  it('should count the length after trimming', () => {
    expect(Email.create(`  ${emailOfLength(254)}  `).value).toHaveLength(254);
  });
});

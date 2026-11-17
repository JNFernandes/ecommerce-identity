import { ifNoneMatchMatches } from '../../../src/controllers/if-none-match';

describe('ifNoneMatchMatches', () => {
  const etag = '"abc123"';

  it.each<[string, string | undefined, boolean]>([
    ['no header', undefined, false],
    ['the exact ETag', '"abc123"', true],
    ['the ETag with spaces around it', '  "abc123"  ', true],
    ['a list containing the ETag', '"old", "abc123" ,"other"', true],
    ['a weak form of the ETag', 'W/"abc123"', true],
    ['a list with the weak form', '"old", W/"abc123"', true],
    ['the wildcard', '*', true],
    ['a stale ETag', '"old"', false],
    ['a list of stale ETags', '"old", "older"', false],
    ['an unquoted value', 'abc123', false],
    ['an empty header', '', false],
    ['only commas', ' , ,', false],
    ['a wildcard inside a list', '"old", *', false],
  ])('should handle %s', (_case, header, expected) => {
    expect(ifNoneMatchMatches(header, etag)).toBe(expected);
  });
});

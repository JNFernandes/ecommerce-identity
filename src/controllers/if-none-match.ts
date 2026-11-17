/**
 * Whether an `If-None-Match` request header matches the current `ETag` (RFC 9110 weak
 * comparison). `*` matches any representation; otherwise the header is a comma-separated list of
 * entity tags, each compared after trimming and dropping a `W/` prefix. Pure.
 *
 * @param header The raw `If-None-Match` header, if any.
 * @param etag The current strong `ETag`, quoted.
 * @returns `true` when the client already holds the current representation.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  if (header.trim() === '*') {
    return true;
  }
  const current = stripWeak(etag);
  return header
    .split(',')
    .map((tag) => stripWeak(tag.trim()))
    .some((tag) => tag !== '' && tag === current);
}

/** Drops a leading `W/` weak marker from an entity tag. */
function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

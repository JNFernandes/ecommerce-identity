/**
 * Port for one-way password hashing. Implementations never log, return or store the plain
 * password. Used as the Nest injection token.
 */
export abstract class PasswordHasher {
  /**
   * Hashes a plain password.
   *
   * @param plain The plain password, exactly as the client sent it.
   * @returns The encoded hash (algorithm, parameters, salt and digest), safe to store.
   */
  abstract hash(plain: string): Promise<string>;

  /**
   * Checks a plain password against a stored hash in constant time.
   *
   * @param plain The plain password, exactly as the client sent it (never trimmed).
   * @param hash An encoded hash produced by {@link PasswordHasher.hash}.
   * @returns `true` only when they match; `false` for a mismatch or a malformed hash. Never throws
   * for a mismatch.
   */
  abstract verify(plain: string, hash: string): Promise<boolean>;

  /**
   * A hash of a random secret, made with the same parameters as real hashes. Verifying against it
   * costs the same as a real check and always fails, so an unknown email takes as long as a wrong
   * password.
   */
  abstract dummyHash(): string;
}

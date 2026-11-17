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
}

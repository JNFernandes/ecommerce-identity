/**
 * Command to register a new customer account. Carries the raw client input; the handler applies
 * the domain rules. The password is plain text here and must never be logged.
 */
export class RegisterCustomerCommand {
  /**
   * @param email The email as the client sent it (normalized by the domain).
   * @param name The display name as the client sent it (trimmed by the domain).
   * @param password The plain password, exactly as the client sent it.
   */
  constructor(
    readonly email: string,
    readonly name: string,
    readonly password: string,
  ) {}
}

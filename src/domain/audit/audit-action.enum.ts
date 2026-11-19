/** What an administrative mutation did, as recorded in the audit trail (constitution XI). */
export enum AuditAction {
  /** An admin created a user through `POST /users`. */
  USER_CREATED = 'USER_CREATED',
}

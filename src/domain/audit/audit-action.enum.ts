/** What an administrative mutation did, as recorded in the audit trail (constitution XI). */
export enum AuditAction {
  /** An admin created a user through `POST /users`. */
  USER_CREATED = 'USER_CREATED',
  /** An admin changed a user's status through `PATCH /users/{id}/status`. */
  USER_STATUS_CHANGED = 'USER_STATUS_CHANGED',
  /** An admin changed a user's roles through `PUT /users/{id}/roles`. */
  ROLES_CHANGED = 'ROLES_CHANGED',
}

/** Roles a user can hold. Customers register themselves; admins come only from the startup seed. */
export enum Role {
  /** A shopper with a `customerId`. */
  CUSTOMER = 'CUSTOMER',
  /** A back-office operator, created only by the startup seed. */
  ADMIN = 'ADMIN',
}

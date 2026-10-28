/**
 * The demo deployment's tenant and administrator identity constants.
 *
 * Fixed account presets were removed when local sign-in moved to ID/password:
 * the administrator's special ID comes from `ADMIN_LOGIN_ID`, and every other
 * identity is a user registered into the process database.
 */

/** Every local identity belongs to the seeded demo tenant. */
export const DEMO_TENANT_ID = "demo"

/** Group marker carried by the administrator's token. */
export const DEMO_ADMIN_GROUP = "demo-admins"

export const ROLES = ["OWNER", "ACCOUNTANT", "SALES", "WAREHOUSE"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// Roles allowed to see pricing / invoice references / sales value reports.
export const PRICE_VISIBLE_ROLES: Role[] = ["OWNER", "ACCOUNTANT"];

// Roles allowed to edit order line items while a draft.
export const ORDER_EDIT_ROLES: Role[] = ["OWNER", "SALES"];

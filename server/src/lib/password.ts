import { z } from "zod";

export const PASSWORD_POLICY_MESSAGE = "Password must be at least 8 characters and include a letter and a number.";

// Each staff member gets their own account (no shared/default logins) —
// this schema is the one place that's enforced, used by both account
// creation and password changes.
export const passwordSchema = z
  .string()
  .min(8, PASSWORD_POLICY_MESSAGE)
  .regex(/[A-Za-z]/, PASSWORD_POLICY_MESSAGE)
  .regex(/[0-9]/, PASSWORD_POLICY_MESSAGE);

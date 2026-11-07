import type { Role } from "./roles.js";

// Party tags — who a phone number belongs to. A validated String rather than
// a Postgres enum (same reasoning as Role). The call desk routes by this tag
// (see docs/call-desk/CALL_DESK_SYSTEM.md §2–4).
export const PARTY_TAGS = [
  "VIP_FAMILY",
  "VIP_FINANCE",
  "BUYER_TOP",
  "BUYER",
  "LEAD",
  "VENDOR_KEY",
  "VENDOR",
  "STAFF",
  "TRANSPORT",
  "PARTNER",
  "GOVT",
  "BLOCK",
  "UNKNOWN",
] as const;
export type PartyTag = (typeof PARTY_TAGS)[number];

// VIP-class tags: these decide who reaches the founder directly, so only the
// Owner may assign them or move a party out of them.
export const OWNER_ONLY_TAGS: readonly PartyTag[] = ["VIP_FAMILY", "VIP_FINANCE", "BUYER_TOP", "VENDOR_KEY"];

// Personal/family contacts are invisible to everyone but the Owner.
export const OWNER_ONLY_VISIBLE_TAGS: readonly PartyTag[] = ["VIP_FAMILY"];

// Accepts the spellings people actually type in a contact sheet:
// "vip-family", "VIP FAMILY", "Buyer_Top" → VIP_FAMILY / BUYER_TOP.
export function parsePartyTag(value: unknown): PartyTag | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (PARTY_TAGS as readonly string[]).includes(normalized) ? (normalized as PartyTag) : null;
}

export function canAssignTag(role: Role, tag: string): boolean {
  return role === "OWNER" || !(OWNER_ONLY_TAGS as readonly string[]).includes(tag);
}

export function canSeeParty(role: Role, tag: string): boolean {
  return role === "OWNER" || !(OWNER_ONLY_VISIBLE_TAGS as readonly string[]).includes(tag);
}

// Family calls are never recorded, whatever the stored flag says.
export function effectiveRecordCalls(party: { tag: string; recordCalls: boolean }): boolean {
  return party.tag === "VIP_FAMILY" ? false : party.recordCalls;
}

// Normalizes an Indian phone number to E.164 (+91XXXXXXXXXX) so the same
// number typed as "098123 45678", "+91-98123-45678", "919812345678" or sent
// by a telephony provider as "09812345678" all match one stored row.
// Non-Indian numbers are accepted only with an explicit "+" country code.
// Returns null for anything that can't be a real number.
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const input = String(raw).trim();
  const hasPlus = input.startsWith("+");
  let digits = input.replace(/\D/g, "");
  if (!digits) return null;

  if (hasPlus) {
    if (digits.startsWith("91")) return digits.length === 12 && digits[2] !== "0" ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (digits.length !== 10 || digits.startsWith("0")) return null;
  return `+91${digits}`;
}

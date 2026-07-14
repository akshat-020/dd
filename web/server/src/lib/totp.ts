import { generateSecret, generateURI, verifySync } from "otplib";

// TOTP-based 2FA — recommended (opt-in, not forced) for Owner/Accountant
// accounts specifically, since those roles reach pricing/cost data and a
// compromised password alone shouldn't be enough to reach it.
export function generateTotpSecret(): string {
  return generateSecret();
}

export function totpKeyUri(secret: string, email: string): string {
  return generateURI({ issuer: "OMS/ERP", label: email, secret });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return verifySync({ secret, token: code }).valid;
  } catch {
    return false;
  }
}

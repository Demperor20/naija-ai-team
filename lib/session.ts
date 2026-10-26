// lib/session.ts — signed, httpOnly cookie holding the Try-it company id.
// HMAC-SHA256 with SESSION_SECRET, 30-day expiry. Server only.

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE_NAME = "naija_company";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Missing SESSION_SECRET environment variable");
  return s;
}

export function signCompanyId(companyId: string): string {
  const expires = String(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  const payload = `${companyId}.${expires}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifySessionCookie(
  value: string | undefined,
): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [companyId, expires, sig] = parts;
  if (!companyId || !expires || !sig) return null;
  const expiresMs = Number(expires);
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) return null;
  const expected = createHmac("sha256", secret())
    .update(`${companyId}.${expires}`)
    .digest();
  const actual = Buffer.from(sig, "hex");
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  return companyId;
}

export async function setSessionCookie(companyId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, signCompanyId(companyId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function getSessionCompanyId(): Promise<string | null> {
  const store = await cookies();
  return verifySessionCookie(store.get(SESSION_COOKIE_NAME)?.value);
}

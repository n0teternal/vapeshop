const PHONE_AUTH_EMAIL_DOMAIN = "phone.vapeshop.invalid";

function normalizePhoneDigits(rawPhone: string): string {
  let digits = rawPhone.replace(/\D/g, "");
  if (digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length > 0 && !digits.startsWith("7")) digits = `7${digits}`;
  return digits.slice(0, 11);
}

export function formatRussianPhoneInput(rawPhone: string): string {
  const digits = normalizePhoneDigits(rawPhone);
  if (!digits) return "";

  const local = digits.slice(1);
  let formatted = "+7";
  if (local.length > 0) formatted += ` (${local.slice(0, 3)}`;
  if (local.length >= 3) formatted += ")";
  if (local.length > 3) formatted += ` ${local.slice(3, 6)}`;
  if (local.length > 6) formatted += `-${local.slice(6, 8)}`;
  if (local.length > 8) formatted += `-${local.slice(8, 10)}`;
  return formatted;
}

export function normalizeRussianPhone(rawPhone: string): string | null {
  const digits = normalizePhoneDigits(rawPhone);
  if (!/^7[3-9]\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}

export function isLegacyEmailInput(value: string): boolean {
  return /[^\d\s()+-]/.test(value);
}

export function phoneAuthEmail(phone: string): string {
  return `${phone.replace(/\D/g, "")}@${PHONE_AUTH_EMAIL_DOMAIN}`;
}

export function phoneFromAuthEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const escapedDomain = PHONE_AUTH_EMAIL_DOMAIN.replace(/\./g, "\\.");
  const match = new RegExp(`^(7[3-9]\\d{9})@${escapedDomain}$`, "i").exec(email.trim());
  return match?.[1] ? `+${match[1]}` : null;
}

const WEBSITE_PHONE_EMAIL_DOMAIN = "phone.vapeshop.invalid";

/**
 * We deliberately use a technical, non-deliverable Auth email under our
 * reserved domain. This gives phone + password accounts an immediate session
 * without SMS or email confirmation while the customer only ever sees a phone
 * number in the product.
 */
export function phoneAuthEmail(phone: string): string {
  return `${phone.replace(/\D/g, "")}@${WEBSITE_PHONE_EMAIL_DOMAIN}`;
}

export function phoneFromAuthEmail(email: string): string | null {
  const match = new RegExp(`^(7[3-9]\\d{9})@${WEBSITE_PHONE_EMAIL_DOMAIN.replace(/\./g, "\\.")}$`, "i").exec(
    email.trim(),
  );
  return match?.[1] ? `+${match[1]}` : null;
}

export function normalizeRussianPhone(rawPhone: string): string | null {
  let digits = rawPhone.replace(/\D/g, "");
  if (digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (!/^7[3-9]\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}

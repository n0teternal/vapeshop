import { HttpError } from "../httpError.js";
import { createServiceSupabaseClient } from "../supabase/serviceClient.js";

export type CustomerUser = {
  id: number;
  username: string | null;
  phone: string | null;
  email: string | null;
  source: "telegram" | "website" | "dev";
};

function getHeaderString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function readBearerToken(headers: Record<string, unknown>): string | null {
  const authorization = getHeaderString(headers.authorization)?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/**
 * Validates a browser Supabase session server-side and maps it to the existing
 * loyalty/customer key. We intentionally do not trust a user id or email
 * forwarded from the browser.
 */
export async function readWebsiteCustomerUser(params: {
  headers: Record<string, unknown>;
}): Promise<CustomerUser | null> {
  const accessToken = readBearerToken(params.headers);
  if (!accessToken) return null;

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new HttpError(401, "AUTH_SESSION_INVALID", "Сессия истекла. Войдите ещё раз.");
  }

  const email = typeof data.user.email === "string" ? data.user.email.trim().toLowerCase() : "";
  if (!email) {
    throw new HttpError(
      401,
      "AUTH_EMAIL_REQUIRED",
      "Для входа используйте аккаунт сайта с email и паролем.",
    );
  }

  const { data: profileRows, error: profileError } = await supabase.rpc(
    "ensure_web_customer_profile_by_email",
    {
      p_auth_user_id: data.user.id,
      p_email: email,
    },
  );

  if (profileError) {
    throw new HttpError(
      500,
      "DB",
      `Не удалось подготовить профиль покупателя: ${profileError.message}`,
    );
  }

  const profile = profileRows?.[0];
  if (!profile || !Number.isSafeInteger(profile.tg_user_id)) {
    throw new HttpError(500, "DB", "Профиль покупателя вернул некорректные данные.");
  }

  return {
    id: profile.tg_user_id,
    username: null,
    phone: null,
    email: profile.email ?? email,
    source: "website",
  };
}

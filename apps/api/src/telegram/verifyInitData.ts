import crypto from "node:crypto";
import { HttpError } from "../httpError.js";

type InitDataParams = Readonly<Record<string, string>>;

export type TelegramUser = {
  id: number;
  username: string | null;
};

export type VerifiedTelegramInitData = {
  params: InitDataParams;
  authDate: number;
  user: TelegramUser;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseQueryString(initData: string): InitDataParams {
  const searchParams = new URLSearchParams(initData);
  const out: Record<string, string> = {};

  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new HttpError(401, "TG_INIT_DATA_INVALID", `Duplicate key: ${key}`);
    }
    out[key] = value;
  }

  return out;
}

export function parseInitDataUser(userJson: string): TelegramUser {
  let parsed: unknown;
  try {
    parsed = JSON.parse(userJson) as unknown;
  } catch {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Invalid user JSON");
  }

  if (!isRecord(parsed)) {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Invalid user object");
  }

  const id = parsed.id;
  const username = parsed.username;

  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Invalid user.id");
  }

  return {
    id,
    username: typeof username === "string" && username.length > 0 ? username : null,
  };
}

function buildDataCheckString(params: InitDataParams): {
  hash: string;
  dataCheckString: string;
} {
  const hash = params.hash;
  if (typeof hash !== "string" || hash.length === 0) {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Missing hash");
  }

  const pairs = Object.entries(params)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);

  return { hash, dataCheckString: pairs.join("\n") };
}

function hmacSha256Hex(key: crypto.BinaryLike, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

function hmacSha256Buffer(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
): VerifiedTelegramInitData {
  const params = parseQueryString(initData);
  const { hash, dataCheckString } = buildDataCheckString(params);

  const secretKey = hmacSha256Buffer("WebAppData", botToken);
  const calculatedHash = hmacSha256Hex(secretKey, dataCheckString);

  if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Invalid initData hash");
  }

  const authDateRaw = params.auth_date;
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || !Number.isInteger(authDate)) {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Invalid auth_date");
  }

  const userJson = params.user;
  if (typeof userJson !== "string" || userJson.length === 0) {
    throw new HttpError(401, "TG_INIT_DATA_INVALID", "Missing user");
  }

  const user = parseInitDataUser(userJson);

  return { params, authDate, user };
}

import { API_BASE_URL, buildApiUrl } from "../config";

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(params: { code: string; message: string; status: number }) {
    super(params.message);
    this.code = params.code;
    this.status = params.status;
  }
}

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: { code: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseApiEnvelope<T>(value: unknown): ApiOk<T> | ApiErr {
  if (!isRecord(value)) {
    return { ok: false, error: { code: "BAD_RESPONSE", message: "Invalid API response" } };
  }

  if (typeof value.ok !== "boolean") {
    const fallbackMessage =
      typeof value.message === "string" && value.message.trim().length > 0
        ? value.message
        : "Invalid API response";
    const fallbackCode =
      typeof value.code === "string" && value.code.trim().length > 0
        ? value.code
        : typeof value.statusCode === "number"
          ? `HTTP_${value.statusCode}`
          : "BAD_RESPONSE";

    return { ok: false, error: { code: fallbackCode, message: fallbackMessage } };
  }

  if (value.ok === true) {
    return { ok: true, data: value.data as T };
  }

  const err = value.error;
  if (
    isRecord(err) &&
    typeof err.code === "string" &&
    typeof err.message === "string"
  ) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }

  return { ok: false, error: { code: "BAD_RESPONSE", message: "Invalid API response" } };
}

function mergeHeaders(...parts: Array<HeadersInit | undefined>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const part of parts) {
    if (!part) continue;
    if (part instanceof Headers) {
      for (const [k, v] of part.entries()) out[k] = v;
      continue;
    }
    if (Array.isArray(part)) {
      for (const [k, v] of part) out[k] = v;
      continue;
    }
    for (const [k, v] of Object.entries(part)) {
      if (typeof v === "string") out[k] = v;
    }
  }

  return out;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function shouldUseLocalDevBypass(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window !== "undefined" && isLoopbackHost(window.location.hostname)) return true;

  try {
    const apiUrl = new URL(API_BASE_URL, typeof window !== "undefined" ? window.location.href : "http://localhost");
    return isLoopbackHost(apiUrl.hostname);
  } catch {
    return false;
  }
}

type RequestOptions = {
  withTelegramAuth?: boolean;
};

function buildHeaders(extra?: HeadersInit, options?: RequestOptions): HeadersInit {
  const withTelegramAuth = options?.withTelegramAuth !== false;
  if (!withTelegramAuth) {
    return mergeHeaders(extra);
  }

  const tgInitData = window.Telegram?.WebApp?.initData ?? "";
  const base: Record<string, string> = {};

  if (tgInitData) {
    base["x-telegram-init-data"] = tgInitData;
  }

  if (!tgInitData && shouldUseLocalDevBypass()) {
    base["x-dev-admin"] = "1";
  }

  return mergeHeaders(base, extra);
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  options?: RequestOptions,
): Promise<T> {
  const res = await fetch(buildApiUrl(path), {
    ...init,
    headers: buildHeaders(init.headers, options),
  });

  const json = (await res.json().catch(() => null)) as unknown;
  const envelope = parseApiEnvelope<T>(json);

  if (!res.ok || envelope.ok === false) {
    const code = envelope.ok === false ? envelope.error.code : "HTTP_ERROR";
    const message = envelope.ok === false ? envelope.error.message : "Request failed";
    throw new ApiError({ code, message, status: res.status });
  }

  return envelope.data;
}

export function apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
  return requestJson<T>(path, { method: "GET" }, options);
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "DELETE" });
}

export function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    body: form,
  });
}

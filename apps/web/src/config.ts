function readEnvString(key: string): string {
  const raw = import.meta.env[key];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

const DEFAULT_API_BASE_URL = "http://localhost:8787";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function resolveApiBaseUrl(): string {
  const configuredBase = readEnvString("VITE_API_BASE_URL") || DEFAULT_API_BASE_URL;

  if (typeof window === "undefined") return configuredBase;

  try {
    const apiUrl = new URL(configuredBase, window.location.href);
    const pageHost = window.location.hostname;

    if (isLoopbackHost(apiUrl.hostname) && !isLoopbackHost(pageHost)) {
      apiUrl.hostname = pageHost;
      return apiUrl.toString().replace(/\/$/g, "");
    }
  } catch {
    return configuredBase;
  }

  return configuredBase;
}

export const API_BASE_URL: string =
  resolveApiBaseUrl();

function normalizeBase(base: string): string {
  if (base === "/") return "";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function buildApiUrl(path: string): string {
  const base = normalizeBase(API_BASE_URL);
  let nextPath = normalizePath(path);

  if (base.endsWith("/api") && nextPath === "/api") {
    nextPath = "";
  } else if (base.endsWith("/api") && nextPath.startsWith("/api/")) {
    nextPath = nextPath.slice(4);
  }

  return `${base}${nextPath}`;
}

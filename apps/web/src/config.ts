function readEnvString(key: string): string {
  const raw = import.meta.env[key];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

export const API_BASE_URL: string =
  readEnvString("VITE_API_BASE_URL") || "http://localhost:8787";

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

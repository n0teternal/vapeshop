function readEnvString(key: string): string {
  const raw = import.meta.env[key];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

export const API_BASE_URL: string =
  readEnvString("VITE_API_BASE_URL") || "http://localhost:8787";

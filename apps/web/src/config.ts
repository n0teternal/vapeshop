function readEnvString(key: string): string {
  const raw = import.meta.env[key];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

const DEFAULT_API_BASE_URL = "http://localhost:8787";

type DeliveryOrigin = {
  lat: number;
  lon: number;
  label: string;
};

const DEFAULT_DELIVERY_ORIGINS: Record<"vvo" | "blg", DeliveryOrigin> = {
  vvo: { lat: 43.1155, lon: 131.8855, label: "Точка VVO" },
  blg: { lat: 50.258119, lon: 127.534845, label: "Точка отсчета" },
};

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

export const YANDEX_MAPS_API_KEY = readEnvString("VITE_YANDEX_MAPS_API_KEY");
export const YANDEX_MAPS_SUGGEST_API_KEY = readEnvString(
  "VITE_YANDEX_MAPS_SUGGEST_API_KEY",
);

function readEnvBoolean(key: string, defaultValue: boolean): boolean {
  const raw = readEnvString(key).toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export const DELIVERY_UPGRADES_ENABLED = readEnvBoolean(
  "VITE_DELIVERY_UPGRADES_ENABLED",
  true,
);

function readEnvNumber(key: string): number | null {
  const raw = readEnvString(key);
  if (!raw) return null;
  const parsed = Number(raw.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function readDeliveryOrigin(city: "vvo" | "blg"): DeliveryOrigin {
  const prefix = city.toUpperCase();
  const fallback = DEFAULT_DELIVERY_ORIGINS[city];
  return {
    lat: readEnvNumber(`VITE_DELIVERY_ORIGIN_${prefix}_LAT`) ?? fallback.lat,
    lon: readEnvNumber(`VITE_DELIVERY_ORIGIN_${prefix}_LON`) ?? fallback.lon,
    label: readEnvString(`VITE_DELIVERY_ORIGIN_${prefix}_LABEL`) || fallback.label,
  };
}

export const DELIVERY_ORIGINS: Record<"vvo" | "blg", DeliveryOrigin> = {
  vvo: readDeliveryOrigin("vvo"),
  blg: readDeliveryOrigin("blg"),
};

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

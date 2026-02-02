import { isSupabaseConfigured } from "../supabase/client";

function formatKeyPreview(value: string): string {
  if (!value) return "(empty)";
  const prefix = value.slice(0, 12);
  return `${prefix}… (len ${value.length})`;
}

export function DevModeBanner() {
  const showDevEnv = import.meta.env.DEV === true;

  const mode = import.meta.env.MODE;

  const supabaseUrl =
    typeof import.meta.env.VITE_SUPABASE_URL === "string"
      ? import.meta.env.VITE_SUPABASE_URL.trim()
      : "";
  const supabaseAnonKey =
    typeof import.meta.env.VITE_SUPABASE_ANON_KEY === "string"
      ? import.meta.env.VITE_SUPABASE_ANON_KEY.trim()
      : "";
  const apiBaseUrl =
    typeof import.meta.env.VITE_API_BASE_URL === "string"
      ? import.meta.env.VITE_API_BASE_URL.trim()
      : "";

  const suggestModeEnvFile =
    showDevEnv &&
    mode !== "development" &&
    (supabaseUrl.length === 0 || supabaseAnonKey.length === 0 || apiBaseUrl.length === 0);

  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto w-full max-w-md px-4 py-2 text-xs text-amber-900">
        DEV MODE: приложение открыто вне Telegram. Данные WebApp (initData) —
        мок, без подписи.
        {showDevEnv ? (
          <div className="mt-2 space-y-0.5 rounded-lg border border-amber-200 bg-white/70 px-2 py-2 font-mono text-[11px] text-amber-900">
            <div>MODE: {mode}</div>
            <div>VITE_SUPABASE_URL: {supabaseUrl || "(empty)"}</div>
            <div>VITE_SUPABASE_ANON_KEY: {formatKeyPreview(supabaseAnonKey)}</div>
            <div>VITE_API_BASE_URL: {apiBaseUrl || "(empty)"}</div>
            <div>supabaseClientInitialized: {isSupabaseConfigured() ? "true" : "false"}</div>
            {suggestModeEnvFile ? (
              <div className="pt-1 text-amber-800">
                Подсказка: создайте{" "}
                <span className="font-mono">apps/web/.env.{mode}.local</span> (или заполните{" "}
                <span className="font-mono">apps/web/.env.local</span>).
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

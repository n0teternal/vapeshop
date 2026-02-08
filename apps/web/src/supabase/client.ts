import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Database = {
  public: {
    Tables: {
      cities: {
        Row: { id: number; name: string; slug: string };
        Insert: { id?: number; name: string; slug: string };
        Update: { id?: number; name?: string; slug?: string };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          title: string;
          description: string | null;
          category_slug: string;
          base_price: number;
          image_url: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          category_slug?: string;
          base_price: number;
          image_url?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string | null;
          category_slug?: string;
          base_price?: number;
          image_url?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      inventory: {
        Row: {
          id: number;
          product_id: string;
          city_id: number;
          in_stock: boolean;
          stock_qty: number | null;
          price_override: number | null;
        };
        Insert: {
          id?: number;
          product_id: string;
          city_id: number;
          in_stock?: boolean;
          stock_qty?: number | null;
          price_override?: number | null;
        };
        Update: {
          id?: number;
          product_id?: string;
          city_id?: number;
          in_stock?: boolean;
          stock_qty?: number | null;
          price_override?: number | null;
        };
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          tg_user_id: number;
          tg_username: string | null;
          city_id: number | null;
          delivery_method: string;
          comment: string | null;
          status: string;
          total_price: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          tg_user_id: number;
          tg_username?: string | null;
          city_id?: number | null;
          delivery_method: string;
          comment?: string | null;
          status?: string;
          total_price: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          tg_user_id?: number;
          tg_username?: string | null;
          city_id?: number | null;
          delivery_method?: string;
          comment?: string | null;
          status?: string;
          total_price?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      order_items: {
        Row: {
          id: number;
          order_id: string;
          product_id: string | null;
          qty: number;
          unit_price: number;
        };
        Insert: {
          id?: number;
          order_id: string;
          product_id?: string | null;
          qty: number;
          unit_price: number;
        };
        Update: {
          id?: number;
          order_id?: string;
          product_id?: string | null;
          qty?: number;
          unit_price?: number;
        };
        Relationships: [];
      };
      admins: {
        Row: { tg_user_id: number; role: string };
        Insert: { tg_user_id: number; role?: string };
        Update: { tg_user_id?: number; role?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

function readEnvString(key: string): string {
  const raw = import.meta.env[key];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

const supabaseUrl = readEnvString("VITE_SUPABASE_URL");
const supabaseAnonKey = readEnvString("VITE_SUPABASE_ANON_KEY");

function prefix(value: string, len = 12): string {
  if (!value) return "(empty)";
  return value.length <= len ? value : `${value.slice(0, len)}…`;
}

function extractProjectRef(url: string): string {
  const m = url.match(/^https?:\/\/([^./]+)\.supabase\.co\b/i);
  return m?.[1] ?? "";
}

// DEV-only diagnostics to ensure env points to the expected Supabase project.
(() => {
  if (import.meta.env.DEV !== true) return;

  const g = globalThis as unknown as Record<string, unknown>;
  const key = "__miniapp_supabase_env_logged__";
  if (g[key] === true) return;
  g[key] = true;

  const ref = extractProjectRef(supabaseUrl);
  // Never log the full key. URL is not secret, but keep it short to avoid noise.
  console.info(
    `[supabase] ref=${prefix(ref)} url=${prefix(supabaseUrl)} anonKeyLen=${supabaseAnonKey.length}`,
  );
  if (supabaseAnonKey.startsWith("sb_secret_")) {
    console.warn(
      "[supabase] VITE_SUPABASE_ANON_KEY looks like a service role key (sb_secret_*). Do NOT use it in the browser.",
    );
  }
})();

export const supabase: SupabaseClient<Database> | null =
  supabaseUrl && supabaseAnonKey
    ? createClient<Database>(supabaseUrl, supabaseAnonKey)
    : null;

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}

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
          base_price: number;
          image_url: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          base_price: number;
          image_url?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string | null;
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

const supabaseUrl =
  typeof import.meta.env.VITE_SUPABASE_URL === "string"
    ? import.meta.env.VITE_SUPABASE_URL.trim()
    : "";

const supabaseAnonKey =
  typeof import.meta.env.VITE_SUPABASE_ANON_KEY === "string"
    ? import.meta.env.VITE_SUPABASE_ANON_KEY.trim()
    : "";

export const supabase: SupabaseClient<Database> | null =
  supabaseUrl && supabaseAnonKey
    ? createClient<Database>(supabaseUrl, supabaseAnonKey)
    : null;

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

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
      promo_products: {
        Row: {
          id: number;
          city_id: number;
          product_id: string;
          old_price: number;
          new_price: number;
          sort_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          city_id: number;
          product_id: string;
          old_price: number;
          new_price: number;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          city_id?: number;
          product_id?: string;
          old_price?: number;
          new_price?: number;
          sort_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      promotion_rules: {
        Row: {
          id: number;
          city_id: number | null;
          type: string;
          title: string;
          category_slug: string;
          brand: string | null;
          product_ids: string[] | null;
          starts_at: string | null;
          ends_at: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          city_id?: number | null;
          type: string;
          title: string;
          category_slug?: string;
          brand?: string | null;
          product_ids?: string[] | null;
          starts_at?: string | null;
          ends_at?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          city_id?: number | null;
          type?: string;
          title?: string;
          category_slug?: string;
          brand?: string | null;
          product_ids?: string[] | null;
          starts_at?: string | null;
          ends_at?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      promo_codes: {
        Row: {
          code: string;
          discount_amount: number;
          starts_at: string;
          ends_at: string;
          max_uses: number;
          used_count: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          code: string;
          discount_amount: number;
          starts_at: string;
          ends_at: string;
          max_uses: number;
          used_count?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          code?: string;
          discount_amount?: number;
          starts_at?: string;
          ends_at?: string;
          max_uses?: number;
          used_count?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_profiles: {
        Row: {
          tg_user_id: number;
          referral_code: string;
          referred_by_tg_user_id: number | null;
          referral_bound_at: string | null;
          tg_username: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          tg_user_id: number;
          referral_code: string;
          referred_by_tg_user_id?: number | null;
          referral_bound_at?: string | null;
          tg_username?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          tg_user_id?: number;
          referral_code?: string;
          referred_by_tg_user_id?: number | null;
          referral_bound_at?: string | null;
          tg_username?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      referrals: {
        Row: {
          id: number;
          inviter_tg_user_id: number;
          invitee_tg_user_id: number;
          status: string;
          qualified_order_id: string | null;
          qualified_at: string | null;
          rewarded_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          inviter_tg_user_id: number;
          invitee_tg_user_id: number;
          status?: string;
          qualified_order_id?: string | null;
          qualified_at?: string | null;
          rewarded_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          inviter_tg_user_id?: number;
          invitee_tg_user_id?: number;
          status?: string;
          qualified_order_id?: string | null;
          qualified_at?: string | null;
          rewarded_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      coupons: {
        Row: {
          id: string;
          tg_user_id: number;
          kind: string;
          value: number;
          min_order_sum: number;
          max_discount: number | null;
          source: string;
          referral_id: number | null;
          is_used: boolean;
          used_order_id: string | null;
          expires_at: string | null;
          created_at: string;
          used_at: string | null;
        };
        Insert: {
          id?: string;
          tg_user_id: number;
          kind?: string;
          value?: number;
          min_order_sum?: number;
          max_discount?: number | null;
          source?: string;
          referral_id?: number | null;
          is_used?: boolean;
          used_order_id?: string | null;
          expires_at?: string | null;
          created_at?: string;
          used_at?: string | null;
        };
        Update: {
          id?: string;
          tg_user_id?: number;
          kind?: string;
          value?: number;
          min_order_sum?: number;
          max_discount?: number | null;
          source?: string;
          referral_id?: number | null;
          is_used?: boolean;
          used_order_id?: string | null;
          expires_at?: string | null;
          created_at?: string;
          used_at?: string | null;
        };
        Relationships: [];
      };
      loyalty_transactions: {
        Row: {
          id: number;
          tg_user_id: number;
          delta_points: number;
          kind: string;
          referral_id: number | null;
          order_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          tg_user_id: number;
          delta_points: number;
          kind: string;
          referral_id?: number | null;
          order_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          tg_user_id?: number;
          delta_points?: number;
          kind?: string;
          referral_id?: number | null;
          order_id?: string | null;
          created_at?: string;
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
          notify_chat_id: number | null;
          notify_message_id: number | null;
          notify_sent_at: string | null;
          notify_targets: Json;
          coupon_id: string | null;
          coupon_discount_amount: number;
          total_before_discount: number | null;
          promotion_discount_amount: number;
          discount_amount: number;
          total_after_discount: number | null;
          edited_at: string | null;
          edit_session_expires_at: string | null;
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
          notify_chat_id?: number | null;
          notify_message_id?: number | null;
          notify_sent_at?: string | null;
          notify_targets?: Json;
          coupon_id?: string | null;
          coupon_discount_amount?: number;
          total_before_discount?: number | null;
          promotion_discount_amount?: number;
          discount_amount?: number;
          total_after_discount?: number | null;
          edited_at?: string | null;
          edit_session_expires_at?: string | null;
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
          notify_chat_id?: number | null;
          notify_message_id?: number | null;
          notify_sent_at?: string | null;
          notify_targets?: Json;
          coupon_id?: string | null;
          coupon_discount_amount?: number;
          total_before_discount?: number | null;
          promotion_discount_amount?: number;
          discount_amount?: number;
          total_after_discount?: number | null;
          edited_at?: string | null;
          edit_session_expires_at?: string | null;
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

let serviceClient: SupabaseClient<Database> | null = null;

export function createServiceSupabaseClient(): SupabaseClient<Database> {
  if (serviceClient) return serviceClient;
  serviceClient = createClient<Database>(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return serviceClient;
}

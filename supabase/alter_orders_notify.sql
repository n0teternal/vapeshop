-- Add Telegram notification linkage fields to orders
-- Run this AFTER supabase/schema.sql

alter table public.orders
  add column if not exists notify_chat_id bigint,
  add column if not exists notify_message_id bigint,
  add column if not exists notify_sent_at timestamptz;


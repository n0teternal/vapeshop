-- Add Telegram notification linkage fields to orders
-- Run this AFTER supabase/schema.sql

alter table public.orders
  add column if not exists notify_chat_id bigint,
  add column if not exists notify_message_id bigint,
  add column if not exists notify_sent_at timestamptz,
  add column if not exists notify_targets jsonb not null default '[]'::jsonb;

update public.orders
set notify_targets = jsonb_build_array(
  jsonb_build_object(
    'chat_id', notify_chat_id,
    'message_id', notify_message_id
  )
)
where notify_chat_id is not null
  and notify_message_id is not null
  and coalesce(jsonb_array_length(notify_targets), 0) = 0;


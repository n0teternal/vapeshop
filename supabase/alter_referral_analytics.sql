-- Referral funnel analytics.
-- Stores only the existing coarse event fields: customer id, selected city,
-- event name and timestamp. No referral link, recipient or message text is saved.

alter table public.product_analytics_events
  drop constraint if exists product_analytics_events_name_check;

alter table public.product_analytics_events
  add constraint product_analytics_events_name_check
  check (
    event_name in (
      'app_open',
      'catalog_view',
      'cart_add',
      'checkout_view',
      'order_created',
      'referral_view',
      'referral_share'
    )
  );

create index if not exists product_analytics_events_event_occurred_at_idx
  on public.product_analytics_events (event_name, occurred_at desc);

notify pgrst, 'reload schema';

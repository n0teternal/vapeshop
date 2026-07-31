create table if not exists public.delivery_pricing_settings (
  city_slug text primary key,
  base_fee_rub numeric not null default 150,
  rules jsonb not null default '[]'::jsonb,
  peak_surcharge_rules jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (city_slug in ('vvo', 'blg')),
  check (base_fee_rub >= 0 and base_fee_rub <= 10000),
  check (jsonb_typeof(rules) = 'array'),
  check (jsonb_typeof(peak_surcharge_rules) = 'array')
);

alter table public.delivery_pricing_settings
  add column if not exists peak_surcharge_rules jsonb not null default '[]'::jsonb;

do $$
begin
  alter table public.delivery_pricing_settings
    add constraint delivery_pricing_peak_surcharge_rules_array_check
    check (jsonb_typeof(peak_surcharge_rules) = 'array');
exception
  when duplicate_object then
    null;
end $$;

insert into public.delivery_pricing_settings (city_slug, base_fee_rub, rules)
values ('blg', 150, '[]'::jsonb)
on conflict (city_slug) do nothing;

revoke all on public.delivery_pricing_settings from anon, authenticated;
alter table public.delivery_pricing_settings enable row level security;

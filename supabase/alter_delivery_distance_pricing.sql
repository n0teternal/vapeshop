-- Repair the original distance tiers.  The old 3.5/6.5 km limits did not
-- agree with the map zones (3/5/7 km), so addresses in the visible middle
-- zone, including Батарейная, 7, were still charged the base 150 ₽.
--
-- This migration changes only the known empty and legacy rule sets.  Any
-- tariff intentionally changed in the profile settings is left untouched.

alter table public.delivery_pricing_settings
  alter column rules set default '[{"minDistanceKm":3,"feeRub":200},{"minDistanceKm":5,"feeRub":250}]'::jsonb;

insert into public.delivery_pricing_settings (city_slug, base_fee_rub, rules)
values ('blg', 150, '[{"minDistanceKm":3,"feeRub":200},{"minDistanceKm":5,"feeRub":250}]'::jsonb)
on conflict (city_slug) do nothing;

update public.delivery_pricing_settings
set
  rules = '[{"minDistanceKm":3,"feeRub":200},{"minDistanceKm":5,"feeRub":250}]'::jsonb,
  updated_at = now()
where city_slug = 'blg'
  and (
    rules = '[]'::jsonb
    or rules = '[{"minDistanceKm":3.5,"feeRub":200},{"minDistanceKm":6.5,"feeRub":250}]'::jsonb
  );

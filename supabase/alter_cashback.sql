-- Cashback release: run once in the Supabase SQL Editor before deploying the API.
-- One completed order may produce only one cashback credit for its customer.

create unique index if not exists loyalty_order_cashback_unique_idx
  on public.loyalty_transactions (tg_user_id, order_id)
  where order_id is not null
    and kind = 'order_cashback';

notify pgrst, 'reload schema';

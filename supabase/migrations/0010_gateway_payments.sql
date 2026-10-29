-- One row per Razorpay payment the app has heard about from a verified source (signed webhook, verified
-- checkout callback, or reconciliation): paid, failed or refunded. It is the record behind the Google Sheet copy
-- (one Sheet row per payment id, updated in place) and the team notification, each tracked so retries never
-- repeat them. Unpaid enquiries stay in anvaya.leads; browser-only reports never land here. Additive only.
create table if not exists anvaya.gateway_payments (
  provider_payment_id text primary key,
  provider_order_id   text,
  payment_id          bigint references anvaya.payments(id) on delete set null,
  order_id            bigint references anvaya.orders(id) on delete set null,
  student_id          bigint references anvaya.students(id) on delete set null,
  name                text not null default '',
  email               text not null default '',
  phone               text not null default '',
  plan                text not null default '',
  amount_paise        bigint not null default 0,
  refunded_paise      bigint not null default 0,
  method              text not null default '',
  status              text not null check (status in ('paid','failed','refunded','partially_refunded')),
  error_reason        text not null default '',
  occurred_at         timestamptz not null default now(),
  sheet_status        text not null default 'pending' check (sheet_status in ('pending','synced','failed','not_configured')),
  sheet_error         text not null default '',
  sheet_synced_at     timestamptz,
  sheet_synced_state  text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists gateway_payments_sheet_idx on anvaya.gateway_payments (sheet_status) where sheet_status <> 'synced';
grant select, insert, update, delete on anvaya.gateway_payments to anvaya_app;
alter table anvaya.gateway_payments enable row level security;
revoke all on anvaya.gateway_payments from public, anon, authenticated;
drop policy if exists anvaya_app_all on anvaya.gateway_payments;
create policy anvaya_app_all on anvaya.gateway_payments for all to anvaya_app using (true) with check (true);

-- Payment-page checkout enquiries: saved when the visitor submits their details and opens checkout, before any
-- payment. One open enquiry per (email, plan): repeat attempts update it. started → failed (Razorpay reported a
-- failed payment) / abandoned (30 min without a verified payment) → converted (verified payment). Closing the
-- checkout window is only an event, never a failure. Recovery emails go out only with consent. Additive only.
create table if not exists anvaya.checkout_enquiries (
  id                 bigint generated always as identity primary key,
  public_id          text not null unique,            -- handed to the page and carried in Razorpay notes.enquiry
  name               text not null default '',
  email              text not null,
  phone              text not null default '',
  plan_key           text not null,
  plan_name          text not null,
  amount_paise       bigint not null,
  ref_code           text not null default '',
  consent            boolean not null default false,  -- agreed to up to two follow-up emails
  consent_at         timestamptz,
  unsubscribed_at    timestamptz,
  status             text not null default 'started' check (status in ('started','failed','abandoned','converted')),
  attempts           int not null default 1,
  closed_count       int not null default 0,
  last_event         text not null default 'checkout_started',
  failure_reason     text not null default '',
  started_at         timestamptz not null default now(),
  last_activity_at   timestamptz not null default now(),
  failed_at          timestamptz,
  abandoned_at       timestamptz,
  converted_at       timestamptz,
  provider_payment_id text,
  order_id           bigint references anvaya.orders(id) on delete set null,
  student_id         bigint references anvaya.students(id) on delete set null,
  recovery1_job_id   bigint,
  recovery2_job_id   bigint,
  sheet_status       text not null default 'pending' check (sheet_status in ('pending','synced','failed','not_configured')),
  sheet_error        text not null default '',
  sheet_synced_state text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists checkout_enquiries_open_idx on anvaya.checkout_enquiries (lower(email), plan_key) where status <> 'converted';
create index if not exists checkout_enquiries_status_idx on anvaya.checkout_enquiries (status, last_activity_at);
grant select, insert, update, delete on anvaya.checkout_enquiries to anvaya_app;
alter table anvaya.checkout_enquiries enable row level security;
revoke all on anvaya.checkout_enquiries from public, anon, authenticated;
drop policy if exists anvaya_app_all on anvaya.checkout_enquiries;
create policy anvaya_app_all on anvaya.checkout_enquiries for all to anvaya_app using (true) with check (true);

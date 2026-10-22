-- Calendar + session lifecycle: Google Calendar connections, availability overrides, request/approval holds,
-- calendar event + Meet sync state, no-show records with dispute/reversal, booking blocks, preferred-date
-- requests and an email delivery log. Additive only.

-- ── Google Calendar connections (per host user) ───────────────────────
create table if not exists anvaya.calendar_connections (
  id               bigint generated always as identity primary key,
  user_id          bigint not null unique references anvaya.users(id) on delete cascade,
  google_email     text not null,
  refresh_token    jsonb not null,                 -- sealed with APP_SECRET (never stored in plain text)
  busy_calendar_ids text[] not null default array['primary'],
  booking_calendar_id text not null default 'primary',
  status           text not null default 'active' check (status in ('active','error','revoked')),
  last_error       text not null default '',
  connected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── Availability overrides (specific dates): open extra hours or block time ──
create table if not exists anvaya.availability_overrides (
  id          bigint generated always as identity primary key,
  mentor_id   bigint not null references anvaya.mentors(id) on delete cascade,
  day         date not null,                       -- IST calendar date
  start_time  text,                                -- null start/end with kind=blocked = whole day blocked
  end_time    text,
  kind        text not null check (kind in ('open','blocked')),
  note        text not null default '',
  created_by  bigint references anvaya.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists availability_overrides_idx on anvaya.availability_overrides (mentor_id, day);

-- ── Bookings: approval, proposal, calendar/Meet sync, outcome ──────────
alter table anvaya.bookings add column if not exists requested_at timestamptz;
alter table anvaya.bookings add column if not exists approved_at timestamptz;
alter table anvaya.bookings add column if not exists approved_by bigint references anvaya.users(id) on delete set null;
alter table anvaya.bookings add column if not exists proposed_at timestamptz;       -- host's suggested alternative time
alter table anvaya.bookings add column if not exists proposed_by bigint references anvaya.users(id) on delete set null;
alter table anvaya.bookings add column if not exists google_event_id text;
alter table anvaya.bookings add column if not exists google_calendar_id text;
alter table anvaya.bookings add column if not exists calendar_host_user_id bigint references anvaya.users(id) on delete set null;
alter table anvaya.bookings add column if not exists meet_link text;
alter table anvaya.bookings add column if not exists calendar_status text not null default 'none';
alter table anvaya.bookings drop constraint if exists bookings_calendar_status_check;
alter table anvaya.bookings add constraint bookings_calendar_status_check check (calendar_status in ('none','pending','synced','failed','cancelled'));
alter table anvaya.bookings add column if not exists calendar_error text not null default '';
alter table anvaya.bookings add column if not exists outcome text;                  -- attended | student_no_show | host_absent | technical_issue
alter table anvaya.bookings add column if not exists needs_review boolean not null default false;

-- ── No-show records + booking block on the student ─────────────────────
create table if not exists anvaya.no_show_events (
  id              bigint generated always as identity primary key,
  booking_id      bigint not null references anvaya.bookings(id) on delete cascade,
  student_id      bigint not null references anvaya.students(id) on delete cascade,
  marked_by       bigint references anvaya.users(id) on delete set null,
  marked_at       timestamptz not null default now(),
  reason          text not null,
  status          text not null default 'active' check (status in ('active','reversed')),
  disputed_at     timestamptz,
  dispute_case_id bigint references anvaya.support_cases(id) on delete set null,
  reversed_by     bigint references anvaya.users(id) on delete set null,
  reversed_at     timestamptz,
  reverse_reason  text not null default ''
);
create unique index if not exists no_show_events_booking_idx on anvaya.no_show_events (booking_id);
alter table anvaya.students add column if not exists booking_blocked_at timestamptz;
alter table anvaya.students add column if not exists booking_block_event_id bigint references anvaya.no_show_events(id) on delete set null;

alter table anvaya.support_cases drop constraint if exists support_cases_category_check;
alter table anvaya.support_cases add constraint support_cases_category_check check (category in ('general','sessions','payments','technical','mentor','other','no_show_dispute','reschedule_exception'));

-- ── Preferred dates when no slot suits ─────────────────────────────────
create table if not exists anvaya.session_requests (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references anvaya.students(id) on delete cascade,
  mentor_id   bigint references anvaya.mentors(id) on delete set null,
  kind        text not null default 'checkup' check (kind in ('checkup','paid_session')),
  service_id  bigint references anvaya.mentor_services(id) on delete set null,
  preferred   text not null,
  status      text not null default 'open' check (status in ('open','scheduled','closed')),
  created_at  timestamptz not null default now()
);

-- ── Email delivery log (queued → sent → delivered / failed / bounced) ──
create table if not exists anvaya.email_log (
  id           bigint generated always as identity primary key,
  job_id       bigint unique,
  to_email     text not null,
  template     text not null,
  booking_id   bigint references anvaya.bookings(id) on delete set null,
  status       text not null default 'queued' check (status in ('queued','sent','delivered','failed','bounced','complained')),
  provider_id  text,
  error        text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists email_log_provider_idx on anvaya.email_log (provider_id);
create index if not exists email_log_booking_idx on anvaya.email_log (booking_id);

grant select, insert, update, delete on all tables in schema anvaya to anvaya_app;
grant usage, select on all sequences in schema anvaya to anvaya_app;
do $$
declare t text;
begin
  for t in select unnest(array['calendar_connections','availability_overrides','no_show_events','session_requests','email_log'])
  loop
    execute format('alter table anvaya.%I enable row level security', t);
    execute format('revoke all on anvaya.%I from public, anon, authenticated', t);
    execute format('drop policy if exists anvaya_app_all on anvaya.%I', t);
    execute format('create policy anvaya_app_all on anvaya.%I for all to anvaya_app using (true) with check (true)', t);
  end loop;
end $$;

-- Anvaya platform v2: roles, CRM follow-ups, catalogue, commerce, subscriptions, learning, groups,
-- sessions + attendance, service cases + documents, playbook + AI runs, outcomes, mentor ledger,
-- B2B cohorts, webhooks and a durable job queue.
-- Money is stored as integer paise. Timestamps are timestamptz (UTC); the UI shows them in IST.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ═══ Roles & accounts ═════════════════════════════════════════════════
alter table anvaya.users drop constraint if exists users_role_check;
alter table anvaya.users add constraint users_role_check check (role in ('admin','ops','mentor','student','coordinator'));
alter table anvaya.users add column if not exists name text not null default '';
alter table anvaya.users add column if not exists disabled_at timestamptz;

-- Invitations now serve mentors, students and password resets.
alter table anvaya.invitations alter column mentor_id drop not null;
alter table anvaya.invitations add column if not exists user_id bigint references anvaya.users(id) on delete cascade;
alter table anvaya.invitations add column if not exists kind text not null default 'mentor_invite';
alter table anvaya.invitations drop constraint if exists invitations_kind_check;
alter table anvaya.invitations add constraint invitations_kind_check check (kind in ('mentor_invite','student_invite','staff_invite','password_reset'));
update anvaya.invitations i set user_id = m.user_id from anvaya.mentors m where i.mentor_id = m.id and i.user_id is null;
create index if not exists invitations_user_idx on anvaya.invitations (user_id, kind);

-- ═══ Money → paise ════════════════════════════════════════════════════
alter table anvaya.mentors rename column session_price to session_price_paise;
update anvaya.mentors set session_price_paise = session_price_paise * 100;
alter table anvaya.mentors alter column session_price_paise type bigint;
alter table anvaya.mentors add column if not exists max_students integer not null default 12 check (max_students >= 0);
alter table anvaya.mentors add column if not exists accepts_paid_sessions boolean not null default true;
alter table anvaya.mentors add column if not exists checkup_fee_paise bigint not null default 0 check (checkup_fee_paise >= 0);  -- paid by Anvaya per included check-up

drop view if exists anvaya.mentor_earnings;
alter table anvaya.bookings rename column price to price_paise;
alter table anvaya.bookings rename column mentor_fee to mentor_fee_paise;
update anvaya.bookings set price_paise = price_paise * 100, mentor_fee_paise = mentor_fee_paise * 100;
alter table anvaya.bookings alter column price_paise type bigint, alter column mentor_fee_paise type bigint;

alter table anvaya.payments rename column amount to amount_paise;
update anvaya.payments set amount_paise = amount_paise * 100;
alter table anvaya.payments alter column amount_paise type bigint;

-- ═══ Settings (configurable defaults; financial keys are admin-only in the app) ═══
create table if not exists anvaya.settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  bigint references anvaya.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
insert into anvaya.settings (key, value) values
  ('group_capacity_default', '8'),
  ('subscription_grace_days', '5'),
  ('renewal_reminder_days', '[7, 2]'),
  ('booking_hold_minutes', '15'),
  ('booking_min_notice_hours', '12'),
  ('booking_window_days', '21'),
  ('commission_percent', '0'),
  ('ai_monthly_cap_paise', '70000'),
  ('ai_max_runs_per_month', '60')
on conflict (key) do nothing;

-- ═══ B2B: colleges & cohorts ══════════════════════════════════════════
create table if not exists anvaya.colleges (
  id          bigint generated always as identity primary key,
  name        text not null,
  city        text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now()
);
create table if not exists anvaya.college_coordinators (
  college_id  bigint not null references anvaya.colleges(id) on delete cascade,
  user_id     bigint not null references anvaya.users(id) on delete cascade,
  primary key (college_id, user_id)
);

-- ═══ Learning: tracks, modules, assignments ═══════════════════════════
create table if not exists anvaya.tracks (
  id           bigint generated always as identity primary key,
  name         text not null unique,
  target_role  text not null default '',
  description  text not null default '',
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create table if not exists anvaya.modules (
  id           bigint generated always as identity primary key,
  track_id     bigint not null references anvaya.tracks(id) on delete cascade,
  position     integer not null default 0,
  week_number  integer,
  title        text not null,
  description  text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists modules_track_idx on anvaya.modules (track_id, position);
create table if not exists anvaya.assignments (
  id               bigint generated always as identity primary key,
  module_id        bigint not null references anvaya.modules(id) on delete cascade,
  position         integer not null default 0,
  title            text not null,
  instructions     text not null default '',
  due_offset_days  integer,
  created_at       timestamptz not null default now()
);
create index if not exists assignments_module_idx on anvaya.assignments (module_id, position);

create table if not exists anvaya.cohorts (
  id          bigint generated always as identity primary key,
  college_id  bigint references anvaya.colleges(id) on delete set null,
  track_id    bigint references anvaya.tracks(id) on delete set null,
  name        text not null,
  starts_on   date,
  ends_on     date,
  created_at  timestamptz not null default now()
);

-- ═══ Students: portal account + intake ════════════════════════════════
alter table anvaya.students add column if not exists user_id bigint unique references anvaya.users(id) on delete set null;
alter table anvaya.students add column if not exists target_role text not null default '';
alter table anvaya.students add column if not exists prep_level text not null default '';
alter table anvaya.students add column if not exists availability_pref text not null default '';
alter table anvaya.students add column if not exists track_id bigint references anvaya.tracks(id) on delete set null;
alter table anvaya.students add column if not exists linkedin text not null default '';
alter table anvaya.students add column if not exists college_name text not null default '';
alter table anvaya.students add column if not exists graduation_year integer;
alter table anvaya.students add column if not exists intake_completed_at timestamptz;
alter table anvaya.students add column if not exists needs_followup boolean not null default false;
alter table anvaya.students add column if not exists followup_reason text not null default '';
create index if not exists students_track_idx on anvaya.students (track_id);

create table if not exists anvaya.cohort_members (
  cohort_id   bigint not null references anvaya.cohorts(id) on delete cascade,
  student_id  bigint not null references anvaya.students(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (cohort_id, student_id)
);
create index if not exists cohort_members_student_idx on anvaya.cohort_members (student_id);

create table if not exists anvaya.enrollments (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references anvaya.students(id) on delete cascade,
  track_id    bigint not null references anvaya.tracks(id) on delete cascade,
  cohort_id   bigint references anvaya.cohorts(id) on delete set null,
  status      text not null default 'active' check (status in ('active','paused','completed','dropped')),
  started_at  timestamptz not null default now(),
  unique (student_id, track_id)
);
create table if not exists anvaya.assignment_progress (
  student_id     bigint not null references anvaya.students(id) on delete cascade,
  assignment_id  bigint not null references anvaya.assignments(id) on delete cascade,
  status         text not null default 'not_started' check (status in ('not_started','in_progress','submitted','reviewed','done')),
  submission     text not null default '',
  feedback       text not null default '',
  submitted_at   timestamptz,
  reviewed_by    bigint references anvaya.users(id) on delete set null,
  reviewed_at    timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (student_id, assignment_id)
);

-- ═══ CRM: leads + follow-ups ══════════════════════════════════════════
alter table anvaya.leads add column if not exists owner_user_id bigint references anvaya.users(id) on delete set null;
alter table anvaya.leads add column if not exists next_action text not null default '';
alter table anvaya.leads add column if not exists follow_up_at timestamptz;
alter table anvaya.leads add column if not exists sheet_sync_status text not null default 'not_required';
alter table anvaya.leads add column if not exists sheet_sync_error text not null default '';
alter table anvaya.leads add column if not exists sheet_synced_at timestamptz;
alter table anvaya.leads drop constraint if exists leads_sheet_sync_status_check;
alter table anvaya.leads add constraint leads_sheet_sync_status_check check (sheet_sync_status in ('not_required','pending','synced','failed','sent_by_browser'));
create index if not exists leads_followup_idx on anvaya.leads (follow_up_at) where status not in ('converted','lost');
create table if not exists anvaya.lead_activities (
  id          bigint generated always as identity primary key,
  lead_id     bigint not null references anvaya.leads(id) on delete cascade,
  user_id     bigint references anvaya.users(id) on delete set null,
  kind        text not null default 'note' check (kind in ('note','call','whatsapp','email','meeting','status_change','system')),
  body        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists lead_activities_lead_idx on anvaya.lead_activities (lead_id, created_at desc);

-- ═══ Catalogue: products, plans, entitlements ═════════════════════════
create table if not exists anvaya.products (
  id               bigint generated always as identity primary key,
  kind             text not null check (kind in ('subscription_plan','mentor_session','resume_service','linkedin_service','coaching_package','digital_product')),
  name             text not null,
  description      text not null default '',
  price_paise      bigint not null default 0 check (price_paise >= 0),
  billing_period   text not null default 'one_time' check (billing_period in ('one_time','week','month','quarter','half_year','year')),
  active           boolean not null default true,
  digital_document_id bigint,      -- digital products: the file delivered after purchase
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create table if not exists anvaya.plan_entitlements (
  id           bigint generated always as identity primary key,
  product_id   bigint not null references anvaya.products(id) on delete cascade,
  key          text not null check (key in ('syllabus','live_class','mentor_room','checkup_call','progress_tracking','community','paid_session_discount')),
  limit_count  integer check (limit_count is null or limit_count >= 0),   -- null = included with no counted quantity (e.g. syllabus access)
  per_period   text not null default 'month' check (per_period in ('week','month','billing_period','total')),
  notes        text not null default '',
  unique (product_id, key)
);

-- ═══ Commerce: orders, payments, refunds, subscriptions ═══════════════
create table if not exists anvaya.orders (
  id                 bigint generated always as identity primary key,
  student_id         bigint not null references anvaya.students(id) on delete restrict,
  product_id         bigint references anvaya.products(id) on delete set null,
  description        text not null default '',
  amount_paise       bigint not null check (amount_paise >= 0),
  currency           text not null default 'INR',
  status             text not null default 'created' check (status in ('created','paid','failed','cancelled','refunded','partially_refunded')),
  provider           text not null default 'manual' check (provider in ('manual','razorpay')),
  provider_order_id  text unique,
  created_by         bigint references anvaya.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  resolved_at        timestamptz
);
create index if not exists orders_student_idx on anvaya.orders (student_id);
create index if not exists orders_unresolved_idx on anvaya.orders (created_at) where status = 'created';

alter table anvaya.payments add column if not exists order_id bigint references anvaya.orders(id) on delete set null;
alter table anvaya.payments add column if not exists provider text not null default 'manual';
alter table anvaya.payments add column if not exists provider_payment_id text;
alter table anvaya.payments add column if not exists fee_paise bigint not null default 0;   -- gateway fee: Anvaya expense
alter table anvaya.payments add column if not exists tax_paise bigint not null default 0;   -- GST on gateway fee: Anvaya expense
create unique index if not exists payments_provider_payment_key on anvaya.payments (provider, provider_payment_id) where provider_payment_id is not null;

create table if not exists anvaya.refunds (
  id                  bigint generated always as identity primary key,
  payment_id          bigint not null references anvaya.payments(id) on delete restrict,
  amount_paise        bigint not null check (amount_paise > 0),
  reason              text not null default '',
  status              text not null default 'processed' check (status in ('pending','processed','failed')),
  provider_refund_id  text unique,
  created_by          bigint references anvaya.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create table if not exists anvaya.subscriptions (
  id                      bigint generated always as identity primary key,
  student_id              bigint not null references anvaya.students(id) on delete cascade,
  product_id              bigint not null references anvaya.products(id) on delete restrict,
  access_status           text not null default 'active' check (access_status in ('active','grace','paused','cancelled','expired')),
  billing_status          text not null default 'paid' check (billing_status in ('paid','due','overdue','failed','waived','refunded')),
  started_at              timestamptz not null default now(),
  paid_through            timestamptz not null,
  grace_until             timestamptz,
  cancel_at_period_end    boolean not null default false,
  cancelled_at            timestamptz,
  last_reminder_days      integer,
  last_order_id           bigint references anvaya.orders(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists subscriptions_student_idx on anvaya.subscriptions (student_id);
create unique index if not exists subscriptions_one_live_per_plan on anvaya.subscriptions (student_id, product_id) where access_status in ('active','grace','paused');

-- ═══ Groups ═══════════════════════════════════════════════════════════
create table if not exists anvaya.mentor_groups (
  id              bigint generated always as identity primary key,
  name            text not null,
  track_id        bigint references anvaya.tracks(id) on delete set null,
  cohort_id       bigint references anvaya.cohorts(id) on delete set null,
  mentor_id       bigint references anvaya.mentors(id) on delete set null,
  target_role     text not null default '',
  prep_level      text not null default '',
  availability    text not null default '',
  capacity        integer not null default 8 check (capacity > 0),
  meet_link       text not null default '',
  whatsapp_link   text not null default '',
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create table if not exists anvaya.group_members (
  id           bigint generated always as identity primary key,
  group_id     bigint not null references anvaya.mentor_groups(id) on delete cascade,
  student_id   bigint not null references anvaya.students(id) on delete cascade,
  is_override  boolean not null default false,
  assigned_by  bigint references anvaya.users(id) on delete set null,
  joined_at    timestamptz not null default now(),
  left_at      timestamptz
);
create unique index if not exists group_members_active_key on anvaya.group_members (group_id, student_id) where left_at is null;
create unique index if not exists group_members_one_group on anvaya.group_members (student_id) where left_at is null;

-- ═══ Sessions calendar + attendance ═══════════════════════════════════
create table if not exists anvaya.live_sessions (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('live_class','group_room')),
  title        text not null,
  track_id     bigint references anvaya.tracks(id) on delete set null,
  group_id     bigint references anvaya.mentor_groups(id) on delete set null,
  cohort_id    bigint references anvaya.cohorts(id) on delete set null,
  mentor_id    bigint references anvaya.mentors(id) on delete set null,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  meet_link    text not null default '',
  status       text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  delivery_fee_paise bigint not null default 0 check (delivery_fee_paise >= 0),  -- what Anvaya pays the mentor to run it
  notes        text not null default '',
  created_by   bigint references anvaya.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists live_sessions_time_idx on anvaya.live_sessions (starts_at);

-- Bookings: 1:1 paid sessions and included check-ups, with no overlaps per mentor.
alter table anvaya.bookings drop constraint if exists bookings_status_check;
alter table anvaya.bookings add constraint bookings_status_check check (status in ('pending_payment','requested','scheduled','completed','cancelled','no_show'));
alter table anvaya.bookings add column if not exists kind text not null default 'paid_session';
alter table anvaya.bookings drop constraint if exists bookings_kind_check;
alter table anvaya.bookings add constraint bookings_kind_check check (kind in ('paid_session','checkup'));
alter table anvaya.bookings add column if not exists order_id bigint references anvaya.orders(id) on delete set null;
alter table anvaya.bookings add column if not exists subscription_id bigint references anvaya.subscriptions(id) on delete set null;
alter table anvaya.bookings add column if not exists hold_expires_at timestamptz;
alter table anvaya.bookings add column if not exists cancelled_at timestamptz;
alter table anvaya.bookings add column if not exists cancel_reason text not null default '';
alter table anvaya.bookings add column if not exists ends_at timestamptz;
alter table anvaya.bookings add column if not exists created_by bigint references anvaya.users(id) on delete set null;

create or replace function anvaya.set_booking_ends_at() returns trigger language plpgsql as $$
begin
  new.ends_at := new.scheduled_at + make_interval(mins => new.duration);
  return new;
end $$;
drop trigger if exists bookings_ends_at on anvaya.bookings;
create trigger bookings_ends_at before insert or update of scheduled_at, duration on anvaya.bookings
  for each row execute function anvaya.set_booking_ends_at();
update anvaya.bookings set ends_at = scheduled_at + make_interval(mins => duration) where ends_at is null;
alter table anvaya.bookings alter column ends_at set not null;

alter table anvaya.bookings drop constraint if exists bookings_no_overlap;
alter table anvaya.bookings add constraint bookings_no_overlap exclude using gist (
  mentor_id with =, tstzrange(scheduled_at, ends_at, '[)') with &&
) where (mentor_id is not null and status in ('pending_payment','requested','scheduled'));
create index if not exists bookings_hold_idx on anvaya.bookings (hold_expires_at) where status = 'pending_payment';

create table if not exists anvaya.attendance (
  id               bigint generated always as identity primary key,
  live_session_id  bigint references anvaya.live_sessions(id) on delete cascade,
  booking_id       bigint references anvaya.bookings(id) on delete cascade,
  student_id       bigint not null references anvaya.students(id) on delete cascade,
  status           text not null check (status in ('present','late','absent','excused')),
  marked_by        bigint references anvaya.users(id) on delete set null,
  marked_at        timestamptz not null default now(),
  check ((live_session_id is null) <> (booking_id is null))
);
create unique index if not exists attendance_live_key on anvaya.attendance (live_session_id, student_id) where live_session_id is not null;
create unique index if not exists attendance_booking_key on anvaya.attendance (booking_id, student_id) where booking_id is not null;

-- ═══ Documents, service cases, QA, playbook, AI ═══════════════════════
create table if not exists anvaya.documents (
  id           bigint generated always as identity primary key,
  student_id   bigint references anvaya.students(id) on delete cascade,
  case_id      bigint,
  kind         text not null check (kind in ('resume_upload','source_facts','ai_draft','coach_draft','final','linkedin','digital_product','playbook','other')),
  title        text not null default '',
  visible_to_student boolean not null default false,
  created_by   bigint references anvaya.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists documents_student_idx on anvaya.documents (student_id);
create table if not exists anvaya.document_versions (
  id            bigint generated always as identity primary key,
  document_id   bigint not null references anvaya.documents(id) on delete cascade,
  version       integer not null,
  storage_path  text,                 -- private bucket object path (files)
  mime_type     text not null default '',
  size_bytes    bigint,
  sha256        text,
  body_text     text,                 -- text drafts (AI / coach edits)
  status        text not null default 'ready' check (status in ('uploading','ready','rejected')),
  created_by    bigint references anvaya.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (document_id, version)
);

create table if not exists anvaya.playbook_versions (
  id              bigint generated always as identity primary key,
  version_label   text not null unique,
  document_id     bigint references anvaya.documents(id) on delete set null,
  rubric_text     text not null default '',   -- the drafting rubric used for AI + QA
  notes           text not null default '',
  is_active       boolean not null default false,
  created_by      bigint references anvaya.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists playbook_one_active on anvaya.playbook_versions (is_active) where is_active;

create table if not exists anvaya.service_cases (
  id                   bigint generated always as identity primary key,
  student_id           bigint not null references anvaya.students(id) on delete cascade,
  product_id           bigint references anvaya.products(id) on delete set null,
  order_id             bigint references anvaya.orders(id) on delete set null,
  kind                 text not null check (kind in ('resume_rewrite','linkedin_rewrite','coaching_package')),
  status               text not null default 'intake' check (status in ('intake','assigned','first_draft','coach_edit','qa','delivered','revision','closed','cancelled')),
  coach_mentor_id      bigint references anvaya.mentors(id) on delete set null,
  qa_user_id           bigint references anvaya.users(id) on delete set null,
  playbook_version_id  bigint references anvaya.playbook_versions(id) on delete set null,
  source_facts         text not null default '',
  due_at               timestamptz,
  revisions_allowed    integer not null default 1 check (revisions_allowed >= 0),
  revisions_used       integer not null default 0,
  coach_fee_paise      bigint not null default 0 check (coach_fee_paise >= 0),
  delivered_at         timestamptz,
  approved_by          bigint references anvaya.users(id) on delete set null,
  approved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists service_cases_coach_idx on anvaya.service_cases (coach_mentor_id, status);
alter table anvaya.documents drop constraint if exists documents_case_fk;
alter table anvaya.documents add constraint documents_case_fk foreign key (case_id) references anvaya.service_cases(id) on delete cascade;
alter table anvaya.products drop constraint if exists products_digital_doc_fk;
alter table anvaya.products add constraint products_digital_doc_fk foreign key (digital_document_id) references anvaya.documents(id) on delete set null;

create table if not exists anvaya.case_events (
  id          bigint generated always as identity primary key,
  case_id     bigint not null references anvaya.service_cases(id) on delete cascade,
  user_id     bigint references anvaya.users(id) on delete set null,
  from_status text,
  to_status   text,
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create table if not exists anvaya.qa_reviews (
  id                   bigint generated always as identity primary key,
  case_id              bigint not null references anvaya.service_cases(id) on delete cascade,
  document_version_id  bigint references anvaya.document_versions(id) on delete set null,
  reviewer_user_id     bigint references anvaya.users(id) on delete set null,
  checklist            jsonb not null default '{}',
  verdict              text not null check (verdict in ('pass','changes_requested')),
  comments             text not null default '',
  created_at           timestamptz not null default now()
);
create table if not exists anvaya.ai_runs (
  id                   bigint generated always as identity primary key,
  case_id              bigint references anvaya.service_cases(id) on delete set null,
  playbook_version_id  bigint references anvaya.playbook_versions(id) on delete set null,
  provider             text not null,
  model                text not null,
  purpose              text not null check (purpose in ('gap_questions','draft')),
  status               text not null default 'queued' check (status in ('queued','running','succeeded','failed','blocked_by_cap')),
  input_tokens         integer,
  output_tokens        integer,
  cost_paise           bigint not null default 0,
  output_text          text,
  output_document_version_id bigint references anvaya.document_versions(id) on delete set null,
  error                text,
  created_by           bigint references anvaya.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  finished_at          timestamptz
);

-- ═══ Outcomes & feedback ══════════════════════════════════════════════
create table if not exists anvaya.applications (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references anvaya.students(id) on delete cascade,
  company     text not null,
  role_title  text not null default '',
  stage       text not null default 'applied' check (stage in ('applied','shortlisted','interview','offer','rejected','withdrawn','accepted')),
  applied_on  date,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists applications_student_idx on anvaya.applications (student_id);
create table if not exists anvaya.feedback (
  id               bigint generated always as identity primary key,
  student_id       bigint not null references anvaya.students(id) on delete cascade,
  booking_id       bigint references anvaya.bookings(id) on delete set null,
  live_session_id  bigint references anvaya.live_sessions(id) on delete set null,
  case_id          bigint references anvaya.service_cases(id) on delete set null,
  rating           integer check (rating between 1 and 5),
  comments         text not null default '',
  created_at       timestamptz not null default now()
);

-- ═══ Mentor ledger & payouts ══════════════════════════════════════════
create table if not exists anvaya.payouts (
  id           bigint generated always as identity primary key,
  mentor_id    bigint not null references anvaya.mentors(id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  method       text not null default 'UPI',
  reference    text not null default '',
  paid_at      timestamptz not null default now(),
  recorded_by  bigint references anvaya.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table if not exists anvaya.mentor_ledger (
  id              bigint generated always as identity primary key,
  mentor_id       bigint not null references anvaya.mentors(id) on delete restrict,
  kind            text not null check (kind in ('session_earning','delivery_fee','service_fee','adjustment','refund_adjustment','payout')),
  amount_paise    bigint not null,           -- + owed to mentor, − reduces what's owed
  booking_id      bigint references anvaya.bookings(id) on delete set null,
  live_session_id bigint references anvaya.live_sessions(id) on delete set null,
  case_id         bigint references anvaya.service_cases(id) on delete set null,
  payout_id       bigint references anvaya.payouts(id) on delete set null,
  note            text not null default '',
  created_by      bigint references anvaya.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists mentor_ledger_mentor_idx on anvaya.mentor_ledger (mentor_id, created_at);
-- One earning row per completed booking / delivered session (idempotent completion).
create unique index if not exists mentor_ledger_booking_earning on anvaya.mentor_ledger (booking_id) where kind = 'session_earning';
create unique index if not exists mentor_ledger_live_fee on anvaya.mentor_ledger (live_session_id) where kind = 'delivery_fee' and live_session_id is not null;
create unique index if not exists mentor_ledger_checkup_fee on anvaya.mentor_ledger (booking_id) where kind = 'delivery_fee' and booking_id is not null;
create unique index if not exists mentor_ledger_case_fee on anvaya.mentor_ledger (case_id) where kind = 'service_fee';

-- Earnings from completed private sessions, by month (ledger-based, so refunds are reflected).
create or replace view anvaya.mentor_earnings as
  select mentor_id, date_trunc('month', created_at) as month,
         count(*) filter (where kind = 'session_earning') as sessions,
         sum(amount_paise) filter (where kind in ('session_earning','refund_adjustment')) as amount_paise
  from anvaya.mentor_ledger group by mentor_id, date_trunc('month', created_at);

-- ═══ Webhooks & jobs ══════════════════════════════════════════════════
create table if not exists anvaya.webhook_events (
  id               bigint generated always as identity primary key,
  provider         text not null,
  event_id         text not null,
  event_type       text not null default '',
  payload          jsonb not null,
  signature_valid  boolean not null,
  status           text not null default 'received' check (status in ('received','processed','ignored','failed')),
  error            text,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  unique (provider, event_id)
);
create table if not exists anvaya.jobs (
  id            bigint generated always as identity primary key,
  kind          text not null,
  payload       jsonb not null default '{}',
  status        text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  run_at        timestamptz not null default now(),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  locked_until  timestamptz,
  last_error    text,
  dedupe_key    text unique,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists jobs_due_idx on anvaya.jobs (run_at) where status in ('queued','failed');

-- ═══ Least-privilege app role + RLS ═══════════════════════════════════
-- The app connects as anvaya_app (NOBYPASSRLS). The Data API roles (anon, authenticated) get nothing.
-- RLS is a coarse gate here (only anvaya_app may touch rows); per-user isolation is enforced by the
-- server on every endpoint and covered by tests, because one pooled role serves all users.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anvaya_app') then
    create role anvaya_app nologin nobypassrls;
  end if;
end $$;
grant usage on schema anvaya to anvaya_app;
grant select, insert, update, delete on all tables in schema anvaya to anvaya_app;
grant usage, select on all sequences in schema anvaya to anvaya_app;
grant execute on all functions in schema anvaya to anvaya_app;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'anvaya'
  loop
    execute format('alter table anvaya.%I enable row level security', t);
    execute format('revoke all on anvaya.%I from public, anon, authenticated', t);
    execute format('drop policy if exists anvaya_app_all on anvaya.%I', t);
    execute format('create policy anvaya_app_all on anvaya.%I for all to anvaya_app using (true) with check (true)', t);
  end loop;
end $$;
revoke all on anvaya.mentor_earnings from public, anon, authenticated;
grant select on anvaya.mentor_earnings to anvaya_app;

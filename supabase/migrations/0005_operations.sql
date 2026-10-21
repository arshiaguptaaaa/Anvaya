-- Operations workspace: owners, tasks, unified student timeline (internal notes vs student-visible messages),
-- support requests, saved views, mentor services/photos/buffers, rescheduling, reminder bookkeeping.
-- Additive only: no existing column or row is changed or removed.

-- ── Ownership and follow-ups on students (leads already have owner/next_action/follow_up_at) ──
alter table anvaya.students add column if not exists owner_user_id bigint references anvaya.users(id) on delete set null;
alter table anvaya.students add column if not exists next_action text not null default '';
alter table anvaya.students add column if not exists follow_up_at timestamptz;
alter table anvaya.students add column if not exists onboarding_started_at timestamptz;
alter table anvaya.students add column if not exists assessment_completed_at timestamptz;
alter table anvaya.students add column if not exists progress_reviewed_at timestamptz;
create index if not exists students_owner_idx on anvaya.students (owner_user_id);
create index if not exists students_follow_up_idx on anvaya.students (follow_up_at) where follow_up_at is not null;
create index if not exists leads_owner_idx on anvaya.leads (owner_user_id);
create index if not exists leads_follow_up_idx on anvaya.leads (follow_up_at) where follow_up_at is not null;

-- ── Support requests (raised by students or opened by staff) ─────────────
create table if not exists anvaya.support_cases (
  id             bigint generated always as identity primary key,
  student_id     bigint not null references anvaya.students(id) on delete cascade,
  subject        text not null,
  category       text not null default 'general' check (category in ('general','sessions','payments','technical','mentor','other')),
  status         text not null default 'awaiting_staff' check (status in ('awaiting_staff','awaiting_student','awaiting_mentor','resolved')),
  owner_user_id  bigint references anvaya.users(id) on delete set null,
  created_by     bigint references anvaya.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index if not exists support_cases_student_idx on anvaya.support_cases (student_id);
create index if not exists support_cases_status_idx on anvaya.support_cases (status) where status <> 'resolved';

-- ── Timeline entries for a student record ──────────────────────────────
-- kind: internal_note (staff only), message (visible to the student), system (automatic event, staff only).
-- Email status is set only from the real send result; nothing claims delivery unless Resend accepted it.
create table if not exists anvaya.record_entries (
  id               bigint generated always as identity primary key,
  student_id       bigint references anvaya.students(id) on delete cascade,
  lead_id          bigint references anvaya.leads(id) on delete cascade,
  support_case_id  bigint references anvaya.support_cases(id) on delete cascade,
  kind             text not null check (kind in ('internal_note','message','system')),
  author_user_id   bigint references anvaya.users(id) on delete set null,
  author_role      text not null default 'system',
  body             text not null,
  email_status     text not null default 'not_requested' check (email_status in ('not_requested','queued','delivered','failed')),
  email_error      text not null default '',
  email_job_id     bigint,
  created_at       timestamptz not null default now(),
  check (student_id is not null or lead_id is not null)
);
create index if not exists record_entries_student_idx on anvaya.record_entries (student_id, created_at desc);
create index if not exists record_entries_case_idx on anvaya.record_entries (support_case_id);

-- ── Tasks ──────────────────────────────────────────────────────────────
create table if not exists anvaya.tasks (
  id               bigint generated always as identity primary key,
  title            text not null,
  student_id       bigint references anvaya.students(id) on delete cascade,
  lead_id          bigint references anvaya.leads(id) on delete cascade,
  support_case_id  bigint references anvaya.support_cases(id) on delete cascade,
  owner_user_id    bigint references anvaya.users(id) on delete set null,
  due_at           timestamptz,
  status           text not null default 'open' check (status in ('open','done','cancelled')),
  source           text not null default 'manual',
  dedupe_key       text unique,
  created_by       bigint references anvaya.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  done_at          timestamptz,
  done_by          bigint references anvaya.users(id) on delete set null
);
create index if not exists tasks_open_idx on anvaya.tasks (owner_user_id, due_at) where status = 'open';
create index if not exists tasks_student_idx on anvaya.tasks (student_id);
create index if not exists tasks_lead_idx on anvaya.tasks (lead_id);

-- ── Saved views (per staff user) ───────────────────────────────────────
create table if not exists anvaya.saved_views (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references anvaya.users(id) on delete cascade,
  scope       text not null check (scope in ('leads','students')),
  name        text not null,
  query       jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  unique (user_id, scope, name)
);

-- ── Mentor services, photos and buffers ────────────────────────────────
create table if not exists anvaya.mentor_services (
  id             bigint generated always as identity primary key,
  mentor_id      bigint not null references anvaya.mentors(id) on delete cascade,
  title          text not null,
  description    text not null default '',
  duration_min   integer not null check (duration_min between 15 and 240),
  price_paise    bigint not null check (price_paise >= 0),
  intake_questions jsonb not null default '[]',
  active         boolean not null default true,
  approval       text not null default 'pending' check (approval in ('pending','approved','rejected')),
  approved_by    bigint references anvaya.users(id) on delete set null,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists mentor_services_mentor_idx on anvaya.mentor_services (mentor_id);
alter table anvaya.mentors add column if not exists buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 120);
alter table anvaya.mentors add column if not exists photo_document_id bigint references anvaya.documents(id) on delete set null;
alter table anvaya.mentors add column if not exists photo_status text not null default 'none';
alter table anvaya.mentors drop constraint if exists mentors_photo_status_check;
alter table anvaya.mentors add constraint mentors_photo_status_check check (photo_status in ('none','pending','approved','rejected'));
alter table anvaya.mentors add column if not exists headline text not null default '';
alter table anvaya.mentors add column if not exists years_experience integer;
alter table anvaya.mentors add column if not exists target_roles text not null default '';

-- ── Bookings: service, intake answers, reschedule history, mentor note visibility ──
alter table anvaya.bookings add column if not exists service_id bigint references anvaya.mentor_services(id) on delete set null;
alter table anvaya.bookings add column if not exists intake_answers jsonb not null default '{}';
alter table anvaya.bookings add column if not exists rescheduled_from timestamptz;
alter table anvaya.bookings add column if not exists reschedule_count integer not null default 0;
alter table anvaya.bookings add column if not exists notes_visibility text not null default 'private';
alter table anvaya.bookings drop constraint if exists bookings_notes_visibility_check;
alter table anvaya.bookings add constraint bookings_notes_visibility_check check (notes_visibility in ('private','staff','student'));

-- ── Jobs: allow cancelling queued work (stale reminders) ───────────────
alter table anvaya.jobs drop constraint if exists jobs_status_check;
alter table anvaya.jobs add constraint jobs_status_check check (status in ('queued','running','done','failed','dead','cancelled'));

-- ── Same least-privilege grants + RLS gate as every other table ────────
grant select, insert, update, delete on all tables in schema anvaya to anvaya_app;
grant usage, select on all sequences in schema anvaya to anvaya_app;
do $$
declare t text;
begin
  for t in select unnest(array['support_cases','record_entries','tasks','saved_views','mentor_services'])
  loop
    execute format('alter table anvaya.%I enable row level security', t);
    execute format('revoke all on anvaya.%I from public, anon, authenticated', t);
    execute format('drop policy if exists anvaya_app_all on anvaya.%I', t);
    execute format('create policy anvaya_app_all on anvaya.%I for all to anvaya_app using (true) with check (true)', t);
  end loop;
end $$;

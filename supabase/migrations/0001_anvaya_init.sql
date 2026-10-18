-- Anvaya schema for Supabase Postgres.
-- Lives in its own schema ("anvaya"), which is NOT exposed through Supabase's Data API.
-- Row Level Security is enabled on every table with no policies (the server connects as the table owner, which is not subject to RLS), and the anon / authenticated
-- roles have no privileges, so the browser-facing keys can read or write nothing.
-- Only the server (connecting with the database password via DATABASE_URL) can access these tables.

create schema if not exists anvaya;
revoke all on schema anvaya from public, anon, authenticated;

create table if not exists anvaya.users (
  id             bigint generated always as identity primary key,
  email          text not null,
  password_hash  text,
  role           text not null check (role in ('admin','mentor')),
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);
create unique index if not exists users_email_key on anvaya.users (lower(email));

create table if not exists anvaya.mentors (
  id                 bigint generated always as identity primary key,
  user_id            bigint not null unique references anvaya.users(id) on delete cascade,
  name               text not null,
  expertise          text not null default '',
  bio                text not null default '',
  session_price      integer not null default 0 check (session_price >= 0),
  session_duration   integer not null default 45,
  session_details    text not null default '',
  meeting_link       text not null default '',
  phone              text not null default '',
  linkedin           text not null default '',
  timezone           text not null default 'Asia/Kolkata',
  status             text not null default 'invite_pending' check (status in ('invite_pending','active','deactivated')),
  profile_completed  boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists anvaya.availability (
  id          bigint generated always as identity primary key,
  mentor_id   bigint not null references anvaya.mentors(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  text not null,
  end_time    text not null
);
create index if not exists availability_mentor_idx on anvaya.availability (mentor_id);

create table if not exists anvaya.invitations (
  id          bigint generated always as identity primary key,
  mentor_id   bigint not null references anvaya.mentors(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invitations_mentor_idx on anvaya.invitations (mentor_id);

create table if not exists anvaya.sessions (
  id          bigint generated always as identity primary key,
  token_hash  text not null unique,
  user_id     bigint not null references anvaya.users(id) on delete cascade,
  csrf_token  text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on anvaya.sessions (user_id);

create table if not exists anvaya.students (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null default '',
  phone       text not null default '',
  stage       text not null default '',
  goals       text not null default '',
  plan        text not null default '',
  status      text not null default 'active' check (status in ('active','paused','completed')),
  mentor_id   bigint references anvaya.mentors(id) on delete set null,
  notes       text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists students_mentor_idx on anvaya.students (mentor_id);

create table if not exists anvaya.leads (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null default '',
  phone       text not null default '',
  situation   text not null default '',
  source      text not null default 'Free 15-min chat',
  status      text not null default 'new' check (status in ('new','contacted','qualified','converted','lost')),
  notes       text not null default '',
  student_id  bigint references anvaya.students(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists anvaya.bookings (
  id             bigint generated always as identity primary key,
  student_id     bigint not null references anvaya.students(id) on delete cascade,
  mentor_id      bigint references anvaya.mentors(id) on delete set null,
  service        text not null default '',
  scheduled_at   timestamptz not null,
  duration       integer not null default 45,
  status         text not null default 'scheduled' check (status in ('scheduled','completed','cancelled','no_show')),
  price          integer not null default 0,
  mentor_fee     integer not null default 0,
  meeting_link   text not null default '',
  session_notes  text not null default '',
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists bookings_mentor_idx on anvaya.bookings (mentor_id, scheduled_at);
create index if not exists bookings_student_idx on anvaya.bookings (student_id);

create table if not exists anvaya.payments (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references anvaya.students(id) on delete cascade,
  booking_id  bigint references anvaya.bookings(id) on delete set null,
  amount      integer not null check (amount >= 0),
  method      text not null default 'UPI',
  reference   text not null default '',
  status      text not null default 'paid' check (status in ('pending','paid','refunded','failed')),
  paid_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists anvaya.audit_log (
  id          bigint generated always as identity primary key,
  user_id     bigint,
  action      text not null,
  detail      text not null default '',
  created_at  timestamptz not null default now()
);

-- Serverless-safe rate limiting (shared across function instances).
create table if not exists anvaya.rate_limits (
  key           text primary key,
  window_start  timestamptz not null,
  count         integer not null
);

-- Mentor earnings, derived from completed bookings (always consistent with session records).
create or replace view anvaya.mentor_earnings as
  select mentor_id, date_trunc('month', completed_at) as month, count(*) as sessions, sum(mentor_fee) as amount
  from anvaya.bookings where status = 'completed' and mentor_id is not null
  group by mentor_id, date_trunc('month', completed_at);

do $$
declare t text;
begin
  foreach t in array array['users','mentors','availability','invitations','sessions','students','leads','bookings','payments','audit_log','rate_limits']
  loop
    execute format('alter table anvaya.%I enable row level security', t);
    execute format('revoke all on anvaya.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on anvaya.mentor_earnings from public, anon, authenticated;

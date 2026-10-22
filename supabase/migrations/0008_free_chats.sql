-- Free 15-minute chats booked from the public website: a visitor picks one of the host's open slots, the request is
-- held while the host approves it, then it gets a Google Calendar event + Meet link like any session. Visitors are
-- leads (no account), so free chats live in their own table but share the host's availability and calendar.
-- Additive only.

-- A host profile can be unlisted: it has availability and a calendar, but students never see it as a mentor.
alter table anvaya.mentors add column if not exists listed boolean not null default true;

create table if not exists anvaya.freechats (
  id                    bigint generated always as identity primary key,
  lead_id               bigint references anvaya.leads(id) on delete set null,
  mentor_id             bigint not null references anvaya.mentors(id) on delete cascade,
  name                  text not null,
  email                 text not null,
  phone                 text not null default '',
  situation             text not null default '',
  scheduled_at          timestamptz not null,
  ends_at               timestamptz not null,
  status                text not null default 'requested' check (status in ('requested','scheduled','completed','cancelled','no_show')),
  hold_expires_at       timestamptz,
  approved_at           timestamptz,
  approved_by           bigint references anvaya.users(id) on delete set null,
  cancelled_at          timestamptz,
  cancel_reason         text not null default '',
  google_event_id       text,
  google_calendar_id    text,
  calendar_host_user_id bigint references anvaya.users(id) on delete set null,
  meet_link             text,
  calendar_status       text not null default 'none' check (calendar_status in ('none','pending','synced','failed','cancelled')),
  calendar_error        text not null default '',
  created_at            timestamptz not null default now()
);
create index if not exists freechats_mentor_time_idx on anvaya.freechats (mentor_id, scheduled_at);
create index if not exists freechats_lead_idx on anvaya.freechats (lead_id);

grant select, insert, update, delete on all tables in schema anvaya to anvaya_app;
grant usage, select on all sequences in schema anvaya to anvaya_app;
alter table anvaya.freechats enable row level security;
revoke all on anvaya.freechats from public, anon, authenticated;
drop policy if exists anvaya_app_all on anvaya.freechats;
create policy anvaya_app_all on anvaya.freechats for all to anvaya_app using (true) with check (true);

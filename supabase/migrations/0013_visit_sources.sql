-- Visit-source tracking: links like anvayacareers.in/?src=srcc-consulting-club. The visitor's browser remembers the
-- first and latest code (90 days); the code is stored with their free-chat enquiry or checkout. Clicks per code are
-- counted per day with no personal data. entry = how they reached checkout (e.g. 'quiz' from the plan finder).
-- Additive only.
alter table anvaya.leads add column if not exists ref_source text not null default '';
alter table anvaya.leads add column if not exists ref_first text not null default '';
alter table anvaya.checkout_enquiries add column if not exists ref_source text not null default '';
alter table anvaya.checkout_enquiries add column if not exists ref_first text not null default '';
alter table anvaya.checkout_enquiries add column if not exists entry text not null default '';
create table if not exists anvaya.ref_visits (
  day     date not null,
  source  text not null,
  visits  int not null default 0,
  primary key (day, source)
);
grant select, insert, update, delete on anvaya.ref_visits to anvaya_app;
alter table anvaya.ref_visits enable row level security;
revoke all on anvaya.ref_visits from public, anon, authenticated;
drop policy if exists anvaya_app_all on anvaya.ref_visits;
create policy anvaya_app_all on anvaya.ref_visits for all to anvaya_app using (true) with check (true);

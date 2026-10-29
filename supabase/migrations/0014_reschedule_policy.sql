-- Refund & Rescheduling Policy (26 Oct 2026): students may reschedule once per plan (all sessions bought in one
-- order count together), at least 24 hours before the session. Only reschedules the student makes count; moves made
-- by Anvaya staff or mentors don't. Additive, plus the cutoff setting moves from 2 to 24 hours if it was stored.
alter table anvaya.bookings add column if not exists student_reschedule_count integer not null default 0;
update anvaya.settings set value = '24'::jsonb, updated_at = now() where key = 'reschedule_cutoff_hours' and value = '2'::jsonb;

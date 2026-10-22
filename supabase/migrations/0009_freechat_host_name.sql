-- The unlisted free-chat host profile is shown to website visitors as "Anvaya team" (it was created with the
-- admin account's display name). Only touches that hidden profile, and only if it still has the old name.
update anvaya.mentors set name = 'Anvaya team', updated_at = now()
where not listed and expertise = 'Free chats' and name = 'Admin';

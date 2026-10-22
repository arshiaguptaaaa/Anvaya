# Calendar, Meet and email-tracking setup

Live on revision `anvaya-00014-l52` (migration 0007 applied, all 20 existing settings unchanged).
Nothing here asks for a secret in chat: every value goes into Google's or Resend's own dashboard, or into the hidden-input script.

Until step 4 is done, an approved session stays **Confirmed · Meet failed**, no confirmation email is sent, and staff see a "Calendar/Meet failed" task with a Retry button. This is intentional: placeholder links are never sent.

## 1. Turn on the Google Calendar API (project `zinc-reason-491008-d0`)
Google Cloud Console → **APIs & Services → Library** → search **Google Calendar API** → **Enable**.

## 2. Add the calendar scopes to the OAuth consent screen
**APIs & Services → OAuth consent screen → Data access (Scopes) → Add or remove scopes**:
- `https://www.googleapis.com/auth/calendar.events` (create/update the session events with Meet links)
- `https://www.googleapis.com/auth/calendar.readonly` (read free/busy and the list of calendars)

Save. If the app is still in **Testing**, add each host's Google address under **Test users** (or publish the app).

## 3. Add the second redirect URI to the existing OAuth client
**APIs & Services → Credentials →** the Web client used for "Continue with Google" → **Authorised redirect URIs → Add URI**:

```
https://app.anvayacareers.in/api/calendar/google/callback
```

Keep the existing `…/api/auth/google/callback`. No new variables are needed: it reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## 4. Connect a host calendar
- Admin: **app.anvayacareers.in/admin → Calendar → Connect Google Calendar** → allow calendar access.
- Then pick which calendars count as busy, and which calendar receives the session events.
- Each mentor can do the same from **/mentor → Calendar**. A connected mentor hosts their own events. Otherwise the fallback host is used.
- **Settings → Fallback Google Calendar host:** choose the admin account you just connected (for example teamanvaya.in@gmail.com, once it's an admin).

## 5. Resend delivery tracking (optional but recommended)
1. Resend dashboard → **Webhooks → Add endpoint**
   - URL: `https://app.anvayacareers.in/api/webhooks/resend`
   - Events: `email.delivered`, `email.bounced`, `email.complained`
2. Copy its **signing secret** (starts with `whsec_`). Don't paste it into chat.
3. In Terminal, from the `anvaya` folder, run the command below and paste the value at the hidden prompt. It is merge-only, so the other settings are kept.

   ```bash
   bash scripts/cloudrun-set-secrets.sh RESEND_WEBHOOK_SECRET
   ```

Until then, emails are still tracked as queued, sent or failed. Only the "delivered" and "bounced" updates wait on this step.

## Policy settings (Admin → Settings)
| Setting | Default |
|---|---|
| Hold a requested slot while awaiting approval | 24 h |
| Time to pay after approval | 24 h |
| Self-service reschedule/cancel cutoff | 2 h before start |
| No-show can be confirmed after | 15 min past start |

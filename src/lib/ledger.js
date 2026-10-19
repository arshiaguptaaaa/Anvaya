'use strict';
// Mentor ledger: + amounts are owed to the mentor, − reduce what is owed (refund adjustments, payouts).
// Payable = SUM(amount_paise). Private-session earnings (session_earning) are kept separate from
// delivery fees for classes / mentor rooms (delivery_fee) and resume-service coach fees (service_fee).
// Anvaya currently takes zero commission: the full session fee is the mentor's. Gateway costs are
// Anvaya's expense, recorded on payments.fee_paise / tax_paise.
const db = require('../db');

/** Completed booking → ledger. Paid private sessions are session earnings (full fee, zero commission);
 *  included check-ups are a delivery cost Anvaya pays, kept separate from private-session earnings. */
async function recordSessionEarning(t, booking, userId) {
  if (!booking.mentor_id || !booking.mentor_fee_paise) return;
  const kind = booking.kind === 'checkup' ? 'delivery_fee' : 'session_earning';
  await t.run(`insert into anvaya.mentor_ledger (mentor_id, kind, amount_paise, booking_id, note, created_by)
    values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
  [booking.mentor_id, kind, booking.mentor_fee_paise, booking.id, `${booking.kind === 'checkup' ? 'Check-up call' : 'Private session'}: ${booking.service || 'Session'}`, userId]);
}

/** Refund/cancellation after an earning was recorded: claw back up to the earned amount. */
async function recordRefundAdjustment(t, bookingId, refundPaise, userId, note = 'Refund adjustment') {
  const e = await t.one("select mentor_id, amount_paise from anvaya.mentor_ledger where booking_id = $1 and kind = 'session_earning'", [bookingId]);
  if (!e) return null;
  const already = (await t.one("select coalesce(-sum(amount_paise),0) n from anvaya.mentor_ledger where booking_id = $1 and kind = 'refund_adjustment'", [bookingId])).n;
  const amt = Math.min(refundPaise, e.amount_paise - already);
  if (amt <= 0) return null;
  await t.run(`insert into anvaya.mentor_ledger (mentor_id, kind, amount_paise, booking_id, note, created_by)
    values ($1, 'refund_adjustment', $2, $3, $4, $5)`, [e.mentor_id, -amt, bookingId, note, userId]);
  return amt;
}

async function recordDeliveryFee(t, live, userId) {
  if (!live.mentor_id || !live.delivery_fee_paise) return;
  await t.run(`insert into anvaya.mentor_ledger (mentor_id, kind, amount_paise, live_session_id, note, created_by)
    values ($1, 'delivery_fee', $2, $3, $4, $5) on conflict do nothing`,
  [live.mentor_id, live.delivery_fee_paise, live.id, `${live.kind === 'live_class' ? 'Live class' : 'Mentor room'}: ${live.title}`, userId]);
}

async function recordServiceFee(t, c, userId) {
  if (!c.coach_mentor_id || !c.coach_fee_paise) return;
  await t.run(`insert into anvaya.mentor_ledger (mentor_id, kind, amount_paise, case_id, note, created_by)
    values ($1, 'service_fee', $2, $3, $4, $5) on conflict do nothing`, [c.coach_mentor_id, c.coach_fee_paise, c.id, `Resume service case #${c.id}`, userId]);
}

async function balance(mentorId, q = db) {
  const r = await q.one(`select
      coalesce(sum(amount_paise) filter (where kind = 'session_earning'), 0) as earned_sessions,
      count(*) filter (where kind = 'session_earning') as completed_sessions,
      coalesce(sum(amount_paise) filter (where kind = 'delivery_fee'), 0) as delivery_fees,
      coalesce(sum(amount_paise) filter (where kind = 'service_fee'), 0) as service_fees,
      coalesce(sum(amount_paise) filter (where kind in ('refund_adjustment','adjustment')), 0) as adjustments,
      coalesce(-sum(amount_paise) filter (where kind = 'payout'), 0) as paid_out,
      coalesce(sum(amount_paise), 0) as payable
    from anvaya.mentor_ledger where mentor_id = $1`, [mentorId]);
  return r;
}

async function recordPayout(mentorId, { amount_paise, method, reference, paid_at }, userId) {
  return db.tx(async (t) => {
    await t.one('select id from anvaya.mentors where id = $1 for update', [mentorId]); // serialize payouts per mentor
    const bal = await balance(mentorId, t);
    if (amount_paise > bal.payable) throw Object.assign(new Error('Payout is more than the amount currently payable.'), { status: 400 });
    const p = await t.one(`insert into anvaya.payouts (mentor_id, amount_paise, method, reference, paid_at, recorded_by)
      values ($1,$2,$3,$4,coalesce($5, now()),$6) returning id`, [mentorId, amount_paise, method, reference, paid_at, userId]);
    await t.run(`insert into anvaya.mentor_ledger (mentor_id, kind, amount_paise, payout_id, note, created_by)
      values ($1,'payout',$2,$3,$4,$5)`, [mentorId, -amount_paise, p.id, `Payout via ${method}${reference ? ` (${reference})` : ''}`, userId]);
    return p.id;
  });
}

module.exports = { recordSessionEarning, recordRefundAdjustment, recordDeliveryFee, recordServiceFee, balance, recordPayout };

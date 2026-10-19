'use strict';
// AI assistance for resume services. Rules enforced in the prompt AND by the workflow:
//   • The AI may only use the student's source facts; it must never invent achievements, numbers or experience.
//   • Where a metric or detail is missing it writes a visible placeholder and asks a question.
//   • Output is a draft for a coach. Nothing reaches the student without human QA + admin approval.
// Configuration (server env only): AI_PROVIDER=anthropic, ANTHROPIC_API_KEY, AI_MODEL (default claude-opus-5-5).
// Spend is capped by settings ai_monthly_cap_paise and ai_max_runs_per_month; runs over the cap are refused.
const db = require('../db');
const jobs = require('./jobs');
const settings = require('./settings');

const PROVIDER = process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : '');
const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
// USD per million tokens (input, output). Override with AI_PRICE_IN / AI_PRICE_OUT if you change models.
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };
const [PRICE_IN, PRICE_OUT] = [Number(process.env.AI_PRICE_IN) || (PRICES[MODEL] || [4, 20])[0], Number(process.env.AI_PRICE_OUT) || (PRICES[MODEL] || [4, 20])[1]];
const USD_INR = Number(process.env.USD_INR || 88);
const configured = () => PROVIDER === 'anthropic' && !!process.env.ANTHROPIC_API_KEY;
const costPaise = (inTok, outTok) => Math.ceil(((inTok * PRICE_IN + outTok * PRICE_OUT) / 1e6) * USD_INR * 100);

const SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'string' }, description: 'Questions for the student about missing metrics, dates, scope or outcomes.' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Specific gaps in the source facts (e.g. "no metric for the internship project").' },
    draft: { type: 'string', description: 'The resume draft in plain text, or an empty string for gap_questions runs.' },
    rubric_notes: { type: 'array', items: { type: 'string' }, description: 'How the draft applies the playbook rubric, point by point.' },
  },
  required: ['questions', 'missing', 'draft', 'rubric_notes'],
  additionalProperties: false,
};

const SYSTEM = `You assist Anvaya's resume coaches in India. You work ONLY from the student's source facts provided in the message.
Hard rules:
- Never invent or embellish achievements, numbers, percentages, company names, titles, dates, tools or experience. If it is not in the source facts, it does not go in the draft.
- When a bullet would be stronger with a metric or detail that is missing, write a visible placeholder like [ADD METRIC: how many users?] and add a matching question to "questions".
- Rewording for clarity and impact is allowed; changing meaning is not.
- Apply the playbook rubric supplied by the coach. Note in "rubric_notes" how each rubric point was applied or why it could not be.
- Your output is a draft for a human coach to edit and QA. Do not address the student.`;

async function usageThisMonth() {
  return db.one(`select count(*) as runs, coalesce(sum(cost_paise),0) as cost_paise from anvaya.ai_runs
    where status in ('running','succeeded') and created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`);
}

/** Queues an AI run for a case after checking the monthly cap. Returns the ai_runs id. */
async function requestRun(caseId, purpose, userId) {
  if (!configured()) throw Object.assign(new Error('AI drafting isn’t configured (AI_PROVIDER / ANTHROPIC_API_KEY).'), { status: 503 });
  const c = await db.one('select * from anvaya.service_cases where id = $1', [caseId]);
  if (!c) throw Object.assign(new Error('Case not found.'), { status: 404 });
  if (!c.source_facts.trim()) throw Object.assign(new Error('Add the student’s source facts before running AI.'), { status: 400 });
  const pb = c.playbook_version_id ? await db.one('select * from anvaya.playbook_versions where id = $1', [c.playbook_version_id]) : await db.one('select * from anvaya.playbook_versions where is_active');
  if (!pb || !pb.rubric_text.trim()) throw Object.assign(new Error('Add an active Resume Strategy Playbook version (with its rubric) first.'), { status: 400 });
  const [cfg, used] = [await settings.all(), await usageThisMonth()];
  const blocked = used.runs >= Number(cfg.ai_max_runs_per_month) || used.cost_paise >= Number(cfg.ai_monthly_cap_paise);
  const run = await db.one(`insert into anvaya.ai_runs (case_id, playbook_version_id, provider, model, purpose, status, created_by)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [caseId, pb.id, PROVIDER, MODEL, purpose, blocked ? 'blocked_by_cap' : 'queued', userId]);
  if (blocked) throw Object.assign(new Error('This month’s AI limit has been reached. An admin can raise it in Settings.'), { status: 429 });
  if (!c.playbook_version_id) await db.run('update anvaya.service_cases set playbook_version_id = $1 where id = $2', [pb.id, caseId]);
  const jobId = await jobs.enqueue('ai.run', { runId: run.id }, { dedupeKey: `ai:${run.id}`, maxAttempts: 2 });
  jobs.runNow(jobId).catch(() => {});
  return run.id;
}

jobs.register('ai.run', async ({ runId }) => {
  const run = await db.one('select * from anvaya.ai_runs where id = $1', [runId]);
  if (!run || run.status === 'succeeded') return;
  const c = await db.one('select * from anvaya.service_cases where id = $1', [run.case_id]);
  const pb = await db.one('select * from anvaya.playbook_versions where id = $1', [run.playbook_version_id]);
  await db.run("update anvaya.ai_runs set status = 'running' where id = $1", [runId]);
  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
    const task = run.purpose === 'gap_questions'
      ? 'List the missing metrics, details and questions only. Leave "draft" as an empty string.'
      : `Write a ${c.kind === 'linkedin_rewrite' ? 'LinkedIn profile (headline, about, experience bullets)' : 'one-page resume'} draft from the source facts, following the rubric.`;
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `<playbook version="${pb.version_label}">\n${pb.rubric_text}\n</playbook>\n\n<source_facts>\n${c.source_facts}\n</source_facts>\n\n${task}`,
      }],
    });
    const u = response.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const outTok = u.output_tokens || 0;
    if (response.stop_reason === 'refusal') throw new Error(`The model declined this request (${response.stop_details?.category || 'policy'}).`);
    if (response.stop_reason === 'max_tokens') throw new Error('The draft was cut off (output limit). Try again with shorter source facts.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const out = JSON.parse(text);
    await db.tx(async (t) => {
      let versionId = null;
      if (out.draft && out.draft.trim()) {
        const doc = await t.one(`insert into anvaya.documents (student_id, case_id, kind, title, created_by) values ($1,$2,'ai_draft',$3,$4) returning id`,
          [c.student_id, c.id, `AI draft (${pb.version_label})`, run.created_by]);
        versionId = (await t.one(`insert into anvaya.document_versions (document_id, version, body_text, mime_type, created_by) values ($1,1,$2,'text/plain',$3) returning id`,
          [doc.id, out.draft, run.created_by])).id;
      }
      await t.run(`update anvaya.ai_runs set status = 'succeeded', input_tokens = $2, output_tokens = $3, cost_paise = $4, output_text = $5,
        output_document_version_id = $6, finished_at = now() where id = $1`, [runId, inTok, outTok, costPaise(inTok, outTok), JSON.stringify(out), versionId]);
      if (versionId && ['assigned', 'intake'].includes(c.status)) {
        await t.run("update anvaya.service_cases set status = 'first_draft', updated_at = now() where id = $1", [c.id]);
        await t.run("insert into anvaya.case_events (case_id, user_id, from_status, to_status, note) values ($1,$2,$3,'first_draft','AI first draft created — needs coach edit')", [c.id, run.created_by, c.status]);
      }
    });
    return { input: inTok, output: outTok };
  } catch (e) {
    await db.run("update anvaya.ai_runs set status = 'failed', error = $2, finished_at = now() where id = $1", [runId, String(e.message).slice(0, 500)]);
    throw e;
  }
});

module.exports = { requestRun, configured, usageThisMonth, MODEL, PROVIDER };

'use strict';
// Usage: npm run create-admin -- admin@example.com
// Prompts for the password (not echoed). Creates the admin, or resets the password if the admin exists.
const fs = require('node:fs');
const path = require('node:path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const readline = require('node:readline');
const db = require('./db');
const { hashPassword, passwordProblem } = require('./security');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const email = (process.argv[2] || await ask('Admin email: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('Invalid email.'); process.exit(1); }
  const pw = process.env.ADMIN_PASSWORD_INPUT || await ask('Password (min 10 chars, letters + numbers): ', { hidden: true });
  const problem = passwordProblem(pw);
  if (problem) { console.error(problem); process.exit(1); }
  const existing = await db.one('select id, role from anvaya.users where lower(email) = $1', [email]);
  if (existing && existing.role !== 'admin') { console.error('That email belongs to a mentor account.'); process.exit(1); }
  if (existing) {
    await db.run('update anvaya.users set password_hash = $1 where id = $2', [hashPassword(pw), existing.id]);
    await db.run('delete from anvaya.sessions where user_id = $1', [existing.id]);
    console.log(`Password reset for admin ${email}.`);
  } else {
    await db.run("insert into anvaya.users (email, password_hash, role) values ($1, $2, 'admin')", [email, hashPassword(pw)]);
    console.log(`Admin ${email} created. Sign in at /admin/login`);
  }
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });

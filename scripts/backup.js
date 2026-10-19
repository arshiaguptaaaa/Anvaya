'use strict';
// Exports every anvaya table (JSON) and every private file (Supabase Storage) into backups/<timestamp>/.
// Supabase Pro already keeps daily database backups; this adds an off-platform copy that ALSO includes files,
// which Supabase's database backups do not cover. Run weekly (founder laptop / any machine with the env vars):
//   DATABASE_URL=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backup.js [outDir]
// Then store the folder somewhere private (e.g. an encrypted Google Drive folder).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && !process.env.SKIP_DOTENV) process.loadEnvFile(ENV_FILE);
const db = require('../src/db');
const storage = require('../src/lib/storage');

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups'), stamp);
  fs.mkdirSync(path.join(out, 'tables'), { recursive: true });
  const tables = (await db.all("select tablename from pg_tables where schemaname = 'anvaya' order by tablename")).map((r) => r.tablename);
  const manifest = { created_at: new Date().toISOString(), migrations: (await db.all('select name from public.anvaya_migrations order by name').catch(() => [])).map((r) => r.name), tables: {}, files: [] };
  for (const t of tables) {
    const rows = await db.all(`select * from anvaya.${t} order by 1`);
    fs.writeFileSync(path.join(out, 'tables', `${t}.json`), JSON.stringify(rows));
    manifest.tables[t] = rows.length;
  }
  if (storage.mode() !== 'none') {
    const paths = (await db.all("select storage_path, sha256 from anvaya.document_versions where storage_path is not null and status = 'ready'"));
    for (const p of paths) {
      const buf = await storage.download(p.storage_path);
      const dest = path.join(out, 'files', p.storage_path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      manifest.files.push({ path: p.storage_path, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    }
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Backup written to ${out}\n  tables: ${tables.length} (${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} rows)\n  files: ${manifest.files.length}`);
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });

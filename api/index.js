'use strict';
// Vercel serverless entry: dashboards, invitations and APIs. The public brochure and
// /app, /assets files are served straight from public/ by Vercel's CDN.
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  module.exports = (req, res) => {
    res.statusCode = 503;
    if (req.url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'The database is being connected. Please try again shortly.' }));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anvaya</title><body style="background:#08111f;color:#d9cdb8;font-family:Georgia,serif;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:16px"><h1 style="font-weight:300;color:#f4ede0">Almost <em style="color:#e8c97a">ready</em></h1><p>The Anvaya dashboards are being connected.</p><a href="/" style="color:#c9a84c">Back to Anvaya</a></div>');
  };
} else {
  module.exports = require('../src/app');
}

'use strict';
// Builds the static part of the split setup for Hostinger shared hosting (Single plan):
//   hostinger-site/  →  zip it and upload to public_html.
// Brochure + payment page and their scripts are copied byte for byte.
const fs = require('node:fs');
const path = require('node:path');
const APP = (process.argv[2] || 'https://app.anvayacareers.in').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'hostinger-site');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'app'), { recursive: true });
for (const f of ['index.html', 'anvaya-payment.html']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
fs.cpSync(path.join(ROOT, 'public', 'assets'), path.join(OUT, 'assets'), { recursive: true });
// The public pages' scripts pick the app host themselves when served from anvayacareers.in.
for (const f of ['lead-capture.js', 'site.js', 'site.css', 'src-track.js']) fs.copyFileSync(path.join(ROOT, 'public', 'app', f), path.join(OUT, 'app', f));
fs.writeFileSync(path.join(OUT, '.htaccess'), `# Anvaya static site (Hostinger). The dashboards and APIs live on ${APP}.
Options -Indexes
RewriteEngine On
RewriteCond %{HTTPS} !=on
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]
RewriteRule ^ https://%1%{REQUEST_URI} [R=301,L]
# Old links and email links to the dashboards → app host (path and query kept; 307 keeps POST bodies)
RewriteRule ^(admin|mentor|student|login|invite|reset)(/.*)?$ ${APP}/$1$2 [R=302,L,QSA]
RewriteRule ^api/(.*)$ ${APP}/api/$1 [R=307,L,QSA]
# Same as vercel.json: ?plan=500 → ?plan=500mba
RewriteCond %{QUERY_STRING} (^|&)plan=500($|&)
RewriteRule ^anvaya-payment\\.html$ /anvaya-payment.html?plan=500mba [R=302,L]
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Strict-Transport-Security "max-age=31536000"
  <FilesMatch "\\.js$">
    Header set Cache-Control "public, max-age=300"
  </FilesMatch>
</IfModule>
`);
console.log(`hostinger-site/ built for ${APP}`);

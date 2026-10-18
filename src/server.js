'use strict';
// Local development server. On Vercel, api/index.js serves the same app.
const fs = require('node:fs');
const path = require('node:path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && !process.env.SKIP_DOTENV) process.loadEnvFile(ENV_FILE);

const app = require('./app');
const mailer = require('./mailer');
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Anvaya running at http://localhost:${PORT}  (mail: ${mailer.mailMode()})`));

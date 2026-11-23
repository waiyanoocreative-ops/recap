import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Load .env.local first (local Mac override), then .env; never overwrite shell env vars.
const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: false });
}

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

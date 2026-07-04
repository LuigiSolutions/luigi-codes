#!/usr/bin/env node
/**
 * List (or export) the install-gate signups stored in the Vercel Blob store.
 *
 *   node scripts/leads.mjs           # table of name · email · date
 *   node scripts/leads.mjs --json    # full JSON records to stdout
 *
 * Reads BLOB_READ_WRITE_TOKEN from .env.local (run `npx vercel env pull .env.local`
 * once if the file is missing). The store is private — this token is the only key.
 */
import { readFileSync } from 'fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2];
  }
}

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN not found — run: npx vercel env pull .env.local');
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}`, 'x-api-version': '12' };
const asJson = process.argv.includes('--json');

const { blobs } = await (await fetch('https://vercel.com/api/blob?prefix=leads/', { headers })).json();
const leads = [];
for (const blob of blobs ?? []) {
  const record = await (await fetch(blob.url, { headers })).json();
  leads.push(record);
}
leads.sort((a, b) => (a.at < b.at ? -1 : 1));

if (asJson) {
  console.log(JSON.stringify(leads, null, 2));
} else {
  console.log(`${leads.length} signup(s):\n`);
  for (const lead of leads) {
    console.log(`  ${lead.at.slice(0, 10)}  ${lead.name.padEnd(20)} ${lead.email}`);
  }
}

/**
 * Luigi Codes site: member login.
 *
 * POST /api/login { email }
 *
 * Verifies the email against the signup store (same deterministic path the
 * subscribe endpoint writes) and returns the launcher screen plus the member's
 * first name. No passwords: possession of the signed-up email is the bar for
 * opening an app that only runs on the visitor's own machine anyway.
 */
const crypto = require('node:crypto');
const { LAUNCHER_HTML } = require('./_launcher.js');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body && typeof body === 'object' ? body : {};
  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 120 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'a valid email is required' });
    return;
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    res.status(500).json({ error: 'storage not configured' });
    return;
  }

  const id = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
  const headers = { authorization: `Bearer ${blobToken}`, 'x-api-version': '12' };
  const list = await fetch(
    `https://vercel.com/api/blob?prefix=${encodeURIComponent(`leads/${id}.json`)}&limit=1`,
    { headers }
  );
  if (!list.ok) {
    res.status(502).json({ error: 'could not check the signup list' });
    return;
  }
  const { blobs } = await list.json();
  const match = (blobs ?? [])[0];
  if (!match) {
    res.status(404).json({ error: 'no account found for that email' });
    return;
  }

  let name = '';
  try {
    const record = await (await fetch(match.url, { headers })).json();
    name = String(record.name || '');
  } catch {
    name = '';
  }

  res.status(200).json({ ok: true, name, instructions: LAUNCHER_HTML });
};

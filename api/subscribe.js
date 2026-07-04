/**
 * Luigi Codes site: install-gate lead capture.
 *
 * POST /api/subscribe  { firstName, email, company? (honeypot) }
 *
 * Stores the lead in the project's Vercel Blob store (leads/<sha256(email)>.json,
 * deterministic path = free dedupe) and sends the branded welcome email via
 * Resend when RESEND_API_KEY is configured. With no key, capture still works
 * and the response says emailed:false; the site flow is never blocked.
 *
 * Zero npm dependencies: Blob and Resend are called over their REST APIs.
 */
const crypto = require('node:crypto');

// Luigi Solutions palette (email clients need inline values, not CSS vars).
const CANVAS = '#0b0a09';
const SURFACE = '#16140f';
const INK = '#f3efe7';
const INK_MUTED = '#9c948a';
const GOLD = '#c9a86a';
const HAIRLINE = 'rgba(201, 168, 106, 0.32)';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The setup steps, returned ONLY by this endpoint after a signup. They are
 * deliberately absent from the landing page's HTML so the repo URL cannot be
 * lifted from view-source without leaving an email.
 */
const INSTRUCTIONS_HTML = `
        <div class="step">
          <span class="n">01 · Get a local model</span>
<pre><code>ollama pull qwen2.5-coder:7b       <span class="c"># strong small coder</span>
ollama pull nomic-embed-text       <span class="c"># embeddings for index + memory</span></code></pre>
        </div>
        <div class="step">
          <span class="n">02 · Install the extension</span>
          <p>VS Code Marketplace listing is on its way. Today, build from source. It takes about a minute:</p>
<pre><code>git clone https://github.com/LuigiSolutions/luigi-codes
cd luigi-codes &amp;&amp; npm install &amp;&amp; npm run compile
npx vsce package &amp;&amp; code --install-extension luigi-codes-0.2.0.vsix</code></pre>
        </div>
        <div class="step">
          <span class="n">03 · Meet Luigi</span>
          <p>Click the 🍄 in the activity bar. For your phone: run <em>“Luigi: Open Web App (Desktop &amp; Mobile)”</em> from the command palette.</p>
        </div>`;

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

  const name = String(body.firstName || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase();
  const honeypot = String(body.company || '');

  // Bots fill every field. Accept silently, store nothing, email nobody.
  // (Instructions still returned: an aggressive browser autofill can trip the
  // honeypot on a real person, and a bot gains nothing it couldn't clone.)
  if (honeypot.length > 0) {
    res.status(200).json({ stored: true, emailed: false, instructions: INSTRUCTIONS_HTML });
    return;
  }
  if (name.length === 0 || email.length > 120 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'a first name and a valid email are required' });
    return;
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    res.status(500).json({ error: 'storage not configured' });
    return;
  }

  // ── Store the lead ────────────────────────────────────────────────────────
  // Blob API v12 (the @vercel/blob wire format): PUT vercel.com/api/blob with
  // the pathname as a query param. Deterministic path per email + no overwrite
  // = duplicates are rejected by the store itself ("already exists").
  const id = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
  const record = {
    name,
    email,
    at: new Date().toISOString(),
    source: 'site-install-gate',
  };
  const pathname = encodeURIComponent(`leads/${id}.json`);
  const put = await fetch(`https://vercel.com/api/blob?pathname=${pathname}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${blobToken}`,
      'x-api-version': '12',
      'x-vercel-blob-access': 'private',
      'x-add-random-suffix': '0',
      'x-content-type': 'application/json',
    },
    body: JSON.stringify(record),
  });
  const isNew = put.ok;
  if (!put.ok) {
    const detail = await put.text().catch(() => '');
    if (!/already exists/i.test(detail)) {
      res.status(502).json({ error: 'could not store signup' });
      return;
    }
    // Already subscribed: fine, but no second welcome email.
  }

  // ── Welcome email (only for new signups, only when a sender is configured) ─
  let emailed = false;
  const resendKey = process.env.RESEND_API_KEY;
  if (isNew && resendKey) {
    const from = process.env.LEADS_FROM_EMAIL || 'Luigi Codes <kalob@luigisolutions.com>';
    try {
      const sent = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${resendKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Welcome to Luigi Codes 🍄',
          html: welcomeHtml(name),
          text: welcomeText(name),
        }),
      });
      emailed = sent.ok;
    } catch {
      emailed = false; // capture succeeded; a mail hiccup must not fail the request
    }
  }

  res.status(200).json({ stored: true, already: !isNew, emailed, instructions: INSTRUCTIONS_HTML });
};

function welcomeText(name) {
  return [
    `Hi ${name},`,
    '',
    'Welcome to Luigi Codes, the coding agent that runs entirely on your machine.',
    'No API keys, no per-token bills, no code leaving your computer.',
    '',
    'Get set up in five minutes: https://luigi-codes.vercel.app/#install',
    'Source & docs: https://github.com/LuigiSolutions/luigi-codes',
    '',
    "You'll hear from us occasionally about new features and important releases. Nothing else, no spam.",
    "Don't want these? Just reply \"unsubscribe\".",
    '',
    'Kalob, Luigi Solutions',
    'Built to be owned.',
  ].join('\n');
}

function welcomeHtml(name) {
  const safeName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:${CANVAS};">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="text-align:center;padding-bottom:28px;">
      <div style="font-size:44px;line-height:1;">🍄</div>
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${GOLD};padding-top:14px;">Luigi Solutions · Private Local AI</div>
    </div>
    <div style="background:${SURFACE};border:1px solid ${HAIRLINE};border-radius:4px;padding:32px 28px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:26px;color:${INK};margin:0 0 16px;">Welcome, ${safeName}.</h1>
      <p style="color:${INK_MUTED};font-size:15px;line-height:1.7;margin:0 0 14px;">
        Luigi Codes is the coding agent that runs <em style="color:${INK};">entirely on your machine</em>:
        chat, an autonomous agent with a human approval gate, codebase intelligence, memory,
        and a model that fine-tunes on your own corrections. No API keys. No per-token bills.
        No code leaving your computer.
      </p>
      <p style="color:${INK_MUTED};font-size:15px;line-height:1.7;margin:0 0 24px;">
        You're set up in five minutes:
      </p>
      <div style="text-align:center;padding-bottom:24px;">
        <a href="https://luigi-codes.vercel.app/#install"
           style="display:inline-block;background:${GOLD};color:${CANVAS};text-decoration:none;font-size:13px;letter-spacing:0.15em;text-transform:uppercase;padding:14px 28px;border-radius:2px;">
          Install Luigi Codes
        </a>
      </div>
      <p style="color:${INK_MUTED};font-size:14px;line-height:1.7;margin:0;">
        From here on, we'll email you occasionally about new features and important
        releases. Nothing else, no spam. The source lives at
        <a href="https://github.com/LuigiSolutions/luigi-codes" style="color:${GOLD};">github.com/LuigiSolutions/luigi-codes</a>.
      </p>
    </div>
    <p style="color:${INK_MUTED};font-size:13px;text-align:center;padding-top:24px;margin:0;">
      Kalob, Luigi Solutions · <span style="color:${GOLD};">Built to be owned.</span><br>
      <span style="font-size:12px;">Don't want these emails? Just reply "unsubscribe".</span>
    </p>
  </div>
</body>
</html>`;
}

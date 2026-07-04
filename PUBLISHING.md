# Publishing Luigi Codes to the VS Code Marketplace

Everything machine-doable is already done: `package.json` carries the publisher
(`LuigiSolutions`), icon, gallery banner, categories, keywords, license, and
repository fields; `LICENSE.md` and `CHANGELOG.md` exist; the `.vsix` packages
cleanly and is validated by the test suite and audits. What remains needs a
human with a Microsoft account. Total time: ~10 minutes, all free.

## Step 1 — Create the publisher (one-time, human)

1. Go to https://marketplace.visualstudio.com/manage and sign in with a
   Microsoft account (create one if needed — any email works).
2. Click **Create publisher**. Set the ID to exactly **`LuigiSolutions`**
   (it must match `"publisher"` in package.json) and a display name
   (e.g. "Luigi Solutions").

## Step 2 — Create a Personal Access Token (one-time, human)

1. Go to https://dev.azure.com and sign in with the same Microsoft account.
   Create an organization if it asks (name doesn't matter).
2. User settings (top-right icon) → **Personal access tokens** → **New Token**:
   - Name: `vsce`
   - Organization: **All accessible organizations**
   - Expiration: up to 1 year
   - Scopes: **Custom defined** → Marketplace → **Manage**
3. Copy the token — it is shown once.

## Step 3 — Publish (in this repo)

```bash
npx vsce login LuigiSolutions   # paste the PAT when prompted
npx vsce publish                # publishes the version in package.json
```

Future releases: bump `"version"` in package.json (or `npx vsce publish patch|minor`),
update CHANGELOG.md, and run `npx vsce publish` again. The listing appears at
`https://marketplace.visualstudio.com/items?itemName=LuigiSolutions.luigi-codes`
within a few minutes of the first publish.

## Step 4 — The GitHub repo behind the listing ✅ DONE (2026-07-04)

`https://github.com/LuigiSolutions/luigi-codes` is live: public, `main` branch,
v0.2.0 as the initial commit. HANDOFF.md and `.claude/` are gitignored (session
notes stay off GitHub). Day-to-day: commit and `git push` as usual.

## Step 5 — The project site ✅ DONE (2026-07-04)

**https://luigi-codes.vercel.app** — the landing page in `site/`, hosted on
Vercel's free tier (project `luigi-codes` under your account, static, no
build). Redeploy after editing `site/`: `npx vercel deploy --prod --yes`.
`.vercelignore` ships only `site/` + `vercel.json`; the brand audit covers
`site/`. Optional later: buy a custom domain (~$12/yr, e.g. luigicodes.dev)
and add it in the Vercel dashboard → project → Domains; or connect the GitHub
repo in the dashboard so every push auto-deploys.

## Decisions to confirm before publishing (owner's call)

- **License.** `LICENSE.md` is currently "free to use, no redistribution,
  all rights reserved" — written to protect the Luigi Solutions brand. If you'd
  rather go open source (MIT/Apache-2.0), replace LICENSE.md and set
  `"license": "MIT"` in package.json.
- **The README is the store page.** It currently documents development
  (`npm install`, F5) alongside user features — fine for a v0.2, but worth a
  read-through with "a stranger sees this" eyes before Step 3.

## Sanity checklist (already verified, re-run any time)

```bash
npm run compile && npm test && npm run audit:imports && npm run audit:brand
npx vsce package          # builds luigi-codes-<version>.vsix with zero errors
npx vsce ls               # confirm only runtime files ship (out/, media/, docs)
```

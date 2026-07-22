# mashet-dev

Self-developing PWA. You chat with an AI (via OpenRouter) *inside the running app*,
it proposes file changes, and — once you unlock write access with your deploy secret —
you commit those changes straight to GitHub, which auto-redeploys via Actions.

## Architecture

- **Worker (`src/index.js`)** — serves the PWA shell from KV and exposes:
  - `POST /api/chat` — talk to the dev-AI (read-only, no secret needed)
  - `GET /api/history` — past dev conversation
  - `GET/POST /api/files` — read/write the live KV "filesystem" (needs `x-deploy-secret`)
  - `POST /api/commit` — push an accepted file to GitHub (needs `x-deploy-secret`)
- **KV (`SOURCE_KV`)** — the *live* copy of the frontend the Worker serves right now.
- **D1 (`DB`)** — dev chat history + a full audit log of every file change proposed/committed.
- **GitHub** — the real source of truth. Every commit through `/api/commit` lands here,
  and every push to `main` auto-redeploys the Worker and re-seeds KV.

Secrets (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `DEPLOY_SECRET`) live only
in Worker secrets — never in KV, D1, or any file the app itself can read back out.

## One-time setup (do this once, from a machine you trust)

```bash
npm install -g wrangler
wrangler login                      # opens a browser OAuth prompt — must be you

# Create the D1 database and KV namespace, then paste the IDs into wrangler.toml
wrangler d1 create mashet-pwa-substrate
wrangler kv namespace create SOURCE_KV

# Load the schema
npm run db:init

# Set secrets — you'll be prompted to paste each value, nothing is echoed to screen
wrangler secret put OPENROUTER_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_REPO        # e.g. AGI144348Outlook/mashet-pwa
wrangler secret put DEPLOY_SECRET      # invent a password — this unlocks writes in the app UI

# First deploy + seed
npm run deploy
npm run seed
```

## GitHub Actions setup (so future pushes auto-deploy)

In your GitHub repo → Settings → Secrets and variables → Actions, add:
- `CLOUDFLARE_API_TOKEN` — your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID` — found in the Cloudflare dashboard sidebar

After this, `git push` to `main` is all you need — no more `wrangler login` on shared machines.

## Day to day

1. Open the deployed URL (`https://mashet-dev.<your-subdomain>.workers.dev`)
2. Paste your `DEPLOY_SECRET` once — it's remembered in the browser (localStorage)
3. Chat with the dev-AI about what to build/fix
4. When it proposes a file (rendered as a labeled code block), click **Commit to GitHub**
5. That's it — committed to GitHub *and* live in KV immediately, no redeploy wait

## Promoting dev → stable

Once `mashet-dev` is solid, duplicate this Worker as `mashet-stable` (separate
`wrangler.toml` name, separate KV/D1 if you want full isolation) and only merge
`main` → a `stable` branch when you're ready to promote changes. Keeps experimentation
in dev from ever breaking the version you rely on day to day.

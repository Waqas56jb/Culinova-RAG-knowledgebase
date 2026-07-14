# CULINOVA EOS — Deployment Guide

Three deployables: **server** (API), **admin** (panel), **client** (portal).

---

## 1. Backend API

The API does long-running AI PDF extraction (~20–40s per file). Two options:

### Option A — Render  ✅ recommended (solid, no timeout)
A persistent Node server. The extraction never hits a serverless time limit.

1. Render Dashboard → **New → Blueprint** → select this repo (uses `render.yaml`, which runs
   `npm run migrate` before each deploy and generates `JWT_SECRET` automatically).
   (Or **New → Web Service**, Root Directory `server`, Build `npm install`, Start `npm start`.)
2. Add environment variables:
   - `JWT_SECRET`  ← **required.** A long random string (`openssl rand -base64 48`). Without it the
     server rejects every sign-in and refuses to boot in production. (The blueprint auto-generates it;
     set it manually if you create the service by hand.)
   - `DATABASE_URL`  (Postgres connection string — used by the migration step)
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`  (the `sb_secret_...` key)
   - `OPENAI_API_KEY`
   - `CORS_ORIGINS`  (the admin + client origins, comma-separated)
   - `NODE_ENV=production`
3. Deploy. You get a URL like `https://culinova-eos-server.onrender.com`.
4. Health check: open `/api/health/ready` → returns `{ status: "ready" }` once the DB is reachable.

### Option B — Vercel (serverless)
Works, but each request must finish within the plan's function limit.
**PDF extraction can exceed the Hobby limit and time out.** Use only on a plan
that allows ≥60s functions; otherwise use Render.

- Vercel project **Root Directory = `server`** (config is in `server/vercel.json`).
- Add the SAME environment variables as Render above — **including `JWT_SECRET`** (Project →
  Settings → Environment Variables). Vercel does not auto-generate it; paste a strong random value.
- Run the migrations once from your machine against the production DB: `DATABASE_URL=… npm run migrate`
  (serverless has no pre-deploy hook).
- Redeploy.

> The crash you saw (`FUNCTION_INVOCATION_FAILED`) was because an Express
> `app.listen()` server can't run on serverless. This is now fixed: the app is
> exported as a handler (`server/api/index.js`) and only listens when run directly.

---

## 2. Frontends (admin + client) — Vercel

For **each** frontend project (admin and client):

1. Root Directory = `admin` (or `client`).
2. Framework = Vite. Build `npm run build`, Output `dist`.
3. Environment variable:
   - `VITE_API_BASE` = your backend URL (e.g. `https://culinova-eos-server.onrender.com`)
4. **Redeploy** (Vite bakes env vars in at build time, so redeploy after setting it).

CORS is already configured on the API to allow any `*.vercel.app` origin.

---

## 3. Files & Storage
Uploaded PDFs are stored in **Supabase Storage** (bucket `ceks-files`, auto-created,
public). Source-page links point to these public URLs, so "click to verify" works
from any host. Nothing is stored on the server's local disk in production.

## 4. Semantic search (ChromaDB)
Chroma runs locally for development. It is **not** available on Vercel/Render by default,
so production **falls back to text search** automatically — nothing breaks.
For semantic search in production, run **Chroma Cloud** and set `CHROMA_URL`
(and auth) in the backend env, then `POST /api/reindex` once.

---

## Quick checklist
- [ ] Backend deployed (Render recommended), `/api/health` returns ok
- [ ] Backend env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`
- [ ] admin project: `VITE_API_BASE` = backend URL, redeployed
- [ ] client project: `VITE_API_BASE` = backend URL, redeployed
- [ ] Supabase schema applied (`server/db/schema.sql`)

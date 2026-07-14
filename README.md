# CULINOVA EOS — Engineering Operating System

**Module 1: Engineering Knowledge Module** — Phase 1 pilot.

A knowledge-centric platform where engineering knowledge is entered once and reused everywhere.
Primary workflow: **upload a manufacturer PDF → AI extracts structured knowledge (with source page) →
engineer reviews & approves → published to the read-only User Portal.**

```
server/   Node.js + Express API  (Supabase + OpenAI + ChromaDB)
admin/    React admin panel      (AI PDF Import · review-with-source · approve)
client/   React user portal      (search + view approved knowledge, read-only)
```

## Ingestion methods
1. **AI PDF Import** (primary) — extraction into Draft entries, every field carries `source document + page`.
2. **Excel Bulk Import** (optional migration) — template: `CULINOVA_EOS_Knowledge_Import_Template.xlsx`.
3. **Manual Entry** — `POST /api/ingest/manual`.

All three produce a **Draft Knowledge Entry** that follows Draft → Under Review → Approved.

---

## Setup (one time)

### 1. Database — Supabase
1. Create a Supabase project.
2. Copy the Project URL, the **service_role** key (Settings → API), and the database
   **connection string** (Settings → Database → session pooler).
3. Apply the schema with the **migration runner** — never by pasting `schema.sql`:
   ```bash
   cd server
   cp .env.example .env      # fill in DATABASE_URL, SUPABASE_*, OPENAI_API_KEY, JWT_SECRET
   npm install
   npm run migrate           # bootstraps an empty DB, then applies additive migrations in order
   ```
   `npm run migrate` is safe and idempotent: on a populated database it applies only the additive
   migrations in `db/migrations/` and **refuses** to run the destructive `schema.sql` bootstrap
   (which drops every table). Re-run it any time; it applies each migration exactly once.

### 2. Server
```bash
cd server
npm start
```
`.env` values (see `.env.example` for the full list):
- `DATABASE_URL` — Postgres connection string (used by `npm run migrate`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from step 1
- `JWT_SECRET` — **required**; a long random string. Without it every sign-in is rejected and the
  server refuses to boot in production. Generate one: `openssl rand -base64 48`
- `OPENAI_API_KEY` — your OpenAI key (used for extraction + embeddings + assistant)
- `CORS_ORIGINS` — the admin + client origins
- `CHROMA_URL` — optional; only needed for semantic search

Server runs on **http://localhost:4400** (health: `/api/health`).

### 3. ChromaDB (semantic search)
Run in its own terminal (keep it open):
```bash
pip install chromadb
cd server
chroma run --path ./chroma-data --port 8000      # serves http://localhost:8000 (v2 API)
```
The API connects automatically. If Chroma is down, the portal falls back to text search — nothing breaks.

Entries are indexed into Chroma **when approved**. If Chroma was offline when some entries were
approved, index them all at once (the API now requires a signed-in reviewer — pass a bearer token):
```bash
curl -X POST http://localhost:4400/api/reindex -H "Authorization: Bearer <access-token>"
```

### 4. Admin panel
```bash
cd admin
cp .env.example .env      # VITE_API_BASE=http://localhost:4400
npm install
npm run dev               # http://localhost:5173
```

### 5. User portal
```bash
cd client
cp .env.example .env
npm install
npm run dev               # http://localhost:5174
```

---

## Pilot test flow (10 models)
1. Admin panel → **AI PDF Import** → upload a datasheet (choose document type) → **Extract & create Draft**.
2. **Review Queue** → open the draft → each field shows its **source (document, page)** — click to open that page and verify → correct values if needed → **Approve**.
3. User portal → **search** the approved model → view its full engineering record.

## Key API endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest/pdf` | Upload PDF(s) → AI extract → Draft |
| POST | `/api/ingest/manual` | Manual draft creation |
| GET  | `/api/drafts?status=pending` | Review queue |
| GET  | `/api/entries/:id` | Full entry detail (with source) |
| PATCH| `/api/attributes/:id` | Correct a field |
| POST | `/api/entries/:id/approve` | Approve (+ index into Chroma) |
| GET  | `/api/knowledge?query=` | Search approved (User Portal) |
| GET  | `/api/knowledge/:id` | Approved entry detail |

require("dotenv").config();
const { erpApiUrl, eosCorsOrigins, isProd: deployIsProd } = require("../../../shared/lib/deploy.cjs");

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

const env = {
  port: num(process.env.PORT, 4400),
  nodeEnv: process.env.NODE_ENV || "development",

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

  openaiKey: process.env.OPENAI_API_KEY,
  extractionModel: process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  // an unbounded OpenAI call is an unbounded bill — and a hung request
  openaiTimeoutMs: num(process.env.OPENAI_TIMEOUT_MS, 120000),
  openaiMaxRetries: num(process.env.OPENAI_MAX_RETRIES, 2),

  chromaUrl: process.env.CHROMA_URL || "http://localhost:8000",
  chromaCollection: process.env.CHROMA_COLLECTION || "ceks_knowledge",

  corsOrigins: eosCorsOrigins(),
  // Opt-in: allow any *.vercel.app preview origin. On by default on Vercel.
  corsAllowVercelPreviews: bool(process.env.CORS_ALLOW_VERCEL, deployIsProd),

  // ── RATE LIMITS (per IP; a speed bump, not a distributed limiter) ───────────
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 300),
  rateLimitIngestPer15Min: num(process.env.RATE_LIMIT_INGEST_PER_15MIN, 60),
  rateLimitAiPer5Min: num(process.env.RATE_LIMIT_AI_PER_5MIN, 40),
  rateLimitAuthPer15Min: num(process.env.RATE_LIMIT_AUTH_PER_15MIN, 50),

  // ── AUTH ───────────────────────────────────────────────────────────────────
  // There is deliberately NO default. A guessable signing key is the same as having no
  // authentication at all, and EOS now gates engineering approvals. src/services/auth.js
  // throws rather than issue a token without this.
  jwtSecret: process.env.JWT_SECRET,
  authAccessTtl: process.env.AUTH_ACCESS_TTL || "12h",
  authRefreshDays: num(process.env.AUTH_REFRESH_DAYS, 30),

  // ── STORAGE ──────────────────────────────────────────────────────────────
  storageBucket: process.env.STORAGE_BUCKET || "ceks-files",
  // false → public bucket (portal reads datasheets by direct URL). true → private bucket + signed URLs.
  storagePrivate: bool(process.env.STORAGE_PRIVATE, false),
  storageSignedTtl: num(process.env.STORAGE_SIGNED_TTL, 3600),

  // ── LIMITS (were hardcoded across the codebase) ─────────────────────────────
  uploadMaxFileMb: num(process.env.UPLOAD_MAX_FILE_MB, 50),
  uploadMaxFiles: num(process.env.UPLOAD_MAX_FILES, 400),
  pdfMaxChars: num(process.env.PDF_MAX_CHARS, 60000),
  pageSizeDefault: num(process.env.PAGE_SIZE_DEFAULT, 50),
  pageSizeMax: num(process.env.PAGE_SIZE_MAX, 200),

  // ERP server-to-server integration key for engineering request handoff
  erpIntegrationKey: process.env.ERP_INTEGRATION_KEY || process.env.ERP_EOS_INTEGRATION_KEY || "",
  // Custom ERP API — defaults to culinova-backend.vercel.app on Vercel (override with ERP_API_URL)
  erpApiUrl: erpApiUrl(),
};

function assertConfig() {
  const missing = [];
  if (!env.supabaseUrl) missing.push("SUPABASE_URL");
  if (!env.supabaseKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!env.openaiKey) missing.push("OPENAI_API_KEY");
  if (missing.length) {
    console.warn(
      `[config] Missing env vars: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`
    );
  }

  if (!env.jwtSecret) {
    const msg =
      "[config] JWT_SECRET is not set. Authentication is DISABLED-BY-FAILURE: every sign-in will be " +
      "rejected. Set JWT_SECRET (a long random string) before serving traffic.";
    if (env.nodeEnv === "production") {
      // In production this is not a warning. Refusing to boot is safer than booting insecure.
      throw new Error(msg);
    }
    console.warn(msg);
  } else if (env.jwtSecret.length < 32) {
    console.warn("[config] JWT_SECRET is shorter than 32 characters — use a long random value.");
  }
}

module.exports = { env, assertConfig };

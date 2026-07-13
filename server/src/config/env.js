require("dotenv").config();

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

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

  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // ── AUTH ───────────────────────────────────────────────────────────────────
  // There is deliberately NO default. A guessable signing key is the same as having no
  // authentication at all, and EOS now gates engineering approvals. src/services/auth.js
  // throws rather than issue a token without this.
  jwtSecret: process.env.JWT_SECRET,
  authAccessTtl: process.env.AUTH_ACCESS_TTL || "12h",
  authRefreshDays: num(process.env.AUTH_REFRESH_DAYS, 30),

  // ── LIMITS (were hardcoded across the codebase) ─────────────────────────────
  uploadMaxFileMb: num(process.env.UPLOAD_MAX_FILE_MB, 50),
  uploadMaxFiles: num(process.env.UPLOAD_MAX_FILES, 400),
  pdfMaxChars: num(process.env.PDF_MAX_CHARS, 60000),
  pageSizeDefault: num(process.env.PAGE_SIZE_DEFAULT, 50),
  pageSizeMax: num(process.env.PAGE_SIZE_MAX, 200),
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

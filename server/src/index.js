const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { env, assertConfig } = require("./config/env");
const auth = require("./services/auth");
const { supabase } = require("./config/supabase");
const ingestRoutes = require("./routes/ingest");
const reviewRoutes = require("./routes/review");
const knowledgeRoutes = require("./routes/knowledge");
const adminRoutes = require("./routes/admin");
const assistantRoutes = require("./routes/assistant");
const authRoutes = require("./routes/auth");
const ruleRoutes = require("./routes/rules");
const standardsRoutes = require("./routes/standards");
const dictionaryRoutes = require("./routes/dictionary");
const recommendationRoutes = require("./routes/recommendations");
const projectRoutes = require("./routes/projects");
const drawingRoutes = require("./routes/drawings");

assertConfig();

const app = express();

// Behind Render/Vercel the client IP arrives in X-Forwarded-For. Without this, req.ip is the proxy
// and every user shares one rate-limit bucket (and express-rate-limit refuses to run).
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers. This is an API plus a dev-only static /files mount, so the defaults are right;
// we only relax the resource policy so approved source files can be embedded by the portal.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

// A correlation id per request — logged server-side and returned on errors so a user can quote it.
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
});

/**
 * CORS — an explicit allow-list, not a blanket. Requests with no Origin (server-to-server, curl, the
 * ERP's EOS sync) are always allowed. Browser origins must be either in CORS_ORIGINS, localhost in a
 * non-production build, or a *.vercel.app preview ONLY when explicitly opted in. This closes the old
 * "any *.vercel.app can call us" hole while keeping a documented path for the deployed frontends.
 */
const allowedOrigins = new Set(env.corsOrigins);
const isDev = env.nodeEnv !== "production";
function originAllowed(origin) {
  if (allowedOrigins.has(origin)) return true;
  let hostname;
  try { ({ hostname } = new URL(origin)); } catch { return false; }
  if (isDev && (hostname === "localhost" || hostname === "127.0.0.1")) return true;
  if (env.corsAllowVercelPreviews && hostname.endsWith(".vercel.app")) return true;
  return false;
}
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / same-origin / server-to-server
      cb(null, originAllowed(origin));
    },
  })
);

// serve locally-stored source PDFs (dev only; production uses Supabase Storage signed URLs)
app.use("/files", express.static(path.join(__dirname, "..", "uploads")));

// Identify the caller on EVERY request (reads the bearer token, never rejects). Routes that need a
// signed-in user add auth.authRequired / auth.requirePermission themselves. Until this line, EOS had
// no notion of "who" — created_by / approved_by were NULL on every record ever made.
app.use(auth.attachUser);

// ── rate limiting ─────────────────────────────────────────────────────────────
// A speed bump, honest about its limits: on serverless each instance keeps its own counters, so a
// distributed limiter still belongs at the edge. On the persistent host it genuinely throttles abuse.
const limiterOpts = { standardHeaders: true, legacyHeaders: false, validate: { trustProxy: false } };
const globalLimiter = rateLimit({ windowMs: 60_000, max: env.rateLimitPerMin, ...limiterOpts });
// tighter caps on the routes that cost money (OpenAI) or write bulk data
const writeLimiter = rateLimit({ windowMs: 15 * 60_000, max: env.rateLimitIngestPer15Min, ...limiterOpts });
const aiLimiter = rateLimit({ windowMs: 5 * 60_000, max: env.rateLimitAiPer5Min, ...limiterOpts });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: env.rateLimitAuthPer15Min, ...limiterOpts });
app.use("/api", globalLimiter);

const info = { ok: true, service: "CULINOVA EOS — Engineering Knowledge Module API" };
app.get("/", (_req, res) => res.json({ ...info, ts: Date.now() }));

// Liveness: cheap, touches nothing — "the process is up".
app.get("/api/health", (_req, res) => res.json({ ...info, status: "live", ts: Date.now() }));

// Readiness: "can I actually serve traffic?" — proves the database answers. The platform health
// check should point HERE so a DB outage takes the instance out of rotation instead of serving 500s.
app.get("/api/health/ready", async (_req, res) => {
  try {
    const { error } = await supabase.from("ceks_engine_settings").select("key").limit(1);
    if (error) throw new Error(error.message);
    res.json({ ...info, status: "ready", ts: Date.now() });
  } catch (e) {
    console.error(`[health] not ready:`, e.message);
    res.status(503).json({ ok: false, status: "not_ready", error: "A dependency is unavailable." });
  }
});

// ── authentication & the engineering platform (all guarded) ──────────────────
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/rules", ruleRoutes);
app.use("/api/standards", standardsRoutes);
app.use("/api/dictionary", dictionaryRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/drawings", drawingRoutes);

// ── knowledge management (guarded per-route) ─────────────────────────────────
app.use("/api/ingest", writeLimiter, ingestRoutes);
app.use("/api/admin", adminRoutes); // search/filter/sort/bulk/stats
app.use("/api", aiLimiter, assistantRoutes); // /api/entries/:id/ask, /summary, /engineering-notes (OpenAI cost)
app.use("/api", reviewRoutes); // /api/drafts, /api/entries/:id, /api/attributes/:id ...
app.use("/api/knowledge", knowledgeRoutes); // PUBLIC by design — approved knowledge only

app.use((req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

/**
 * Central error handler — the safety net. Route handlers largely respond directly, but body-parser
 * failures, multer limits, and any thrown error land here. Internal detail is LOGGED, never leaked:
 * the client gets a generic message and the correlation id to quote.
 */
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "That payload is too large.", request_id: req.id });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "That file is too large.", request_id: req.id });
  }
  if (status >= 500) {
    console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}:`, err.stack || err.message);
    return res.status(500).json({ error: "Something went wrong.", request_id: req.id });
  }
  res.status(status).json({ error: err.message, request_id: req.id });
});

// Only start a listening server when run directly (local/persistent hosts).
// On Vercel serverless the app is imported and invoked as a handler instead.
if (require.main === module) {
  const server = app.listen(env.port, () => {
    console.log(`\n  CULINOVA EOS — Engineering Knowledge Module (API)`);
    console.log(`  http://localhost:${env.port}  |  live: /api/health  |  ready: /api/health/ready\n`);
  });

  // Graceful shutdown: stop taking new connections, let in-flight requests finish, then exit. A hard
  // kill mid-ingest can leave a half-written entry; this gives real work a chance to complete.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — draining in-flight requests…`);
    server.close(() => { console.log("[shutdown] closed cleanly."); process.exit(0); });
    setTimeout(() => { console.error("[shutdown] timed out — forcing exit."); process.exit(1); }, 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;

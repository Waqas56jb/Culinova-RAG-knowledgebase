const express = require("express");
const cors = require("cors");
const path = require("path");

const { env, assertConfig } = require("./config/env");
const ingestRoutes = require("./routes/ingest");
const reviewRoutes = require("./routes/review");
const knowledgeRoutes = require("./routes/knowledge");
const adminRoutes = require("./routes/admin");
const assistantRoutes = require("./routes/assistant");

assertConfig();

const app = express();

// CORS: allow configured origins, any localhost port, and *.vercel.app deployments
const allowedOrigins = new Set(env.corsOrigins);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / same-origin / server-to-server
      try {
        const { hostname } = new URL(origin);
        if (
          hostname === "localhost" ||
          hostname === "127.0.0.1" ||
          hostname.endsWith(".vercel.app") ||
          allowedOrigins.has(origin)
        ) {
          return cb(null, true);
        }
      } catch {}
      cb(null, false);
    },
  })
);

// serve locally-stored source PDFs (dev only; production uses Supabase Storage URLs)
app.use("/files", express.static(path.join(__dirname, "..", "uploads")));

const info = { ok: true, service: "CULINOVA EOS — Engineering Knowledge Module API", ts: Date.now() };
app.get("/", (_req, res) => res.json(info));
app.get("/api/health", (_req, res) => res.json({ ...info, ts: Date.now() }));

app.use("/api/ingest", ingestRoutes);
app.use("/api/admin", adminRoutes); // search/filter/sort/bulk/stats
app.use("/api", assistantRoutes); // /api/entries/:id/ask, /summary, /engineering-notes
app.use("/api", reviewRoutes); // /api/drafts, /api/entries/:id, /api/attributes/:id ...
app.use("/api/knowledge", knowledgeRoutes);

app.use((req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

// Only start a listening server when run directly (local/persistent hosts).
// On Vercel serverless the app is imported and invoked as a handler instead.
if (require.main === module) {
  app.listen(env.port, () => {
    console.log(`\n  CULINOVA EOS — Engineering Knowledge Module (API)`);
    console.log(`  http://localhost:${env.port}  |  health: /api/health\n`);
  });
}

module.exports = app;

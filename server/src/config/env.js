require("dotenv").config();

const env = {
  port: parseInt(process.env.PORT || "4400", 10),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  extractionModel: process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  chromaUrl: process.env.CHROMA_URL || "http://localhost:8000",
  chromaCollection: process.env.CHROMA_COLLECTION || "ceks_knowledge",
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

function assertConfig() {
  const missing = [];
  if (!env.supabaseUrl) missing.push("SUPABASE_URL");
  if (!env.supabaseKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!env.openaiKey) missing.push("OPENAI_API_KEY");
  if (missing.length) {
    console.warn(
      `[config] Missing env vars: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill them in.`
    );
  }
}

module.exports = { env, assertConfig };

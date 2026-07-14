const { env } = require("../config/env");
const { openai } = require("../config/openai");

let chromaCollection = null;

// We compute embeddings ourselves (OpenAI) and pass them explicitly to Chroma,
// so this stub prevents chromadb from loading its default (native) embedder.
const stubEmbeddingFunction = { generate: async (texts) => texts.map(() => []) };

function buildClient() {
  const { ChromaClient } = require("chromadb");
  const url = new URL(env.chromaUrl);
  return new ChromaClient({
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 8000),
    ssl: url.protocol === "https:",
  });
}

/** Lazily connect to Chroma; degrade gracefully if unavailable. Retries each call until connected. */
async function getCollection() {
  if (chromaCollection) return chromaCollection;
  try {
    const chroma = buildClient();
    chromaCollection = await chroma.getOrCreateCollection({
      name: env.chromaCollection,
      embeddingFunction: stubEmbeddingFunction,
      metadata: { "hnsw:space": "cosine" },
    });
    console.log(`[chroma] connected: collection "${env.chromaCollection}"`);
    return chromaCollection;
  } catch (err) {
    console.warn(`[chroma] unavailable (${err.message}). Semantic search disabled; falling back to text search.`);
    return null;
  }
}

async function embed(text) {
  const resp = await openai.embeddings.create({
    model: env.embeddingModel,
    input: text.slice(0, 8000),
  });
  return resp.data[0].embedding;
}

/** Index an approved knowledge entry into Chroma. Non-blocking / best-effort. */
async function indexEntry({ id, title, text, metadata }) {
  try {
    const col = await getCollection();
    if (!col) return false;
    const embedding = await embed(`${title}\n\n${text}`);
    await col.upsert({
      ids: [id],
      embeddings: [embedding],
      documents: [text],
      metadatas: [metadata || {}],
    });
    return true;
  } catch (err) {
    console.warn(`[chroma] indexEntry failed for ${id}: ${err.message}`);
    return false;
  }
}

/** Semantic search; returns array of ids or null if Chroma unavailable. */
async function semanticSearch(query, limit = 20) {
  try {
    const col = await getCollection();
    if (!col) return null;
    const embedding = await embed(query);
    const res = await col.query({ queryEmbeddings: [embedding], nResults: limit });
    return (res.ids && res.ids[0]) || [];
  } catch (err) {
    console.warn(`[chroma] search failed: ${err.message}`);
    return null;
  }
}

module.exports = { indexEntry, semanticSearch, embed };

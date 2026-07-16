/**
 * Deployed Culinova URLs — Node/server side (ERP + EOS backends).
 * Override only via env vars when needed; Vercel needs no URL env for defaults.
 */
const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

const URLS = {
  erp: {
    api: "https://culinova-backend.vercel.app",
    client: "https://culinova-client.vercel.app",
    admin: "https://culinova-admin.vercel.app",
    customer: "https://culinova-customer.vercel.app",
  },
  eos: {
    api: "https://culinova-rag-knowledgebase-server.vercel.app",
    client: "https://culinova-rag-knowledgebase-client.vercel.app",
    admin: "https://culinova-rag-knowledgebase-admin.vercel.app",
  },
};

const DEV = {
  erpApi: "http://localhost:5050",
  eosApi: "http://localhost:4400",
};

function stripSlash(u) {
  return String(u || "").replace(/\/$/, "");
}

function erpApiUrl() {
  return stripSlash(process.env.ERP_API_URL || (isProd ? URLS.erp.api : DEV.erpApi));
}

function eosApiUrl() {
  return stripSlash(process.env.EOS_API_URL || (isProd ? URLS.eos.api : DEV.eosApi));
}

function erpCorsOrigins() {
  if (process.env.CORS_ORIGINS) {
    return process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (isProd) {
    return [
      URLS.erp.client,
      URLS.erp.admin,
      URLS.erp.customer,
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:5176",
      "http://localhost:5177",
    ];
  }
  return [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "http://localhost:5177",
  ];
}

function eosCorsOrigins() {
  if (process.env.CORS_ORIGINS) {
    return process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (isProd) {
    return [
      URLS.eos.client,
      URLS.eos.admin,
      "http://localhost:5173",
      "http://localhost:5174",
    ];
  }
  return ["http://localhost:5173", "http://localhost:5174"];
}

module.exports = { URLS, DEV, isProd, erpApiUrl, eosApiUrl, erpCorsOrigins, eosCorsOrigins };

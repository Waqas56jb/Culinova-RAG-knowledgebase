/**
 * Deployed Culinova URLs — single source of truth.
 * Frontends use these when VITE_* env vars are not set.
 * Servers use deploy.server.js (Node) counterparts.
 */
export const URLS = {
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

export const DEV = {
  erpApi: "http://localhost:5050",
  eosApi: "http://localhost:4400",
};

/** EOS portal/admin → EOS API base (no trailing slash). */
export function eosApiBase(viteEnv = import.meta.env) {
  const fromEnv = viteEnv.VITE_API_BASE || viteEnv.VITE_API_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");
  return viteEnv.PROD ? URLS.eos.api : DEV.eosApi;
}

/** Custom ERP frontends → ERP API base including /api suffix. */
export function erpApiBase(viteEnv = import.meta.env) {
  const fromEnv = viteEnv.VITE_API_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");
  return viteEnv.PROD ? `${URLS.erp.api}/api` : `${DEV.erpApi}/api`;
}

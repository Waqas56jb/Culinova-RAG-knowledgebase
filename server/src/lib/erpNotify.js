/**
 * Push engineering request updates from EOS back to the Custom ERP.
 * Uses the same shared integration key as the ERP → EOS handoff.
 */
const { env } = require("../config/env");

async function notifyErpEngineeringSync(payload) {
  const key = env.erpIntegrationKey;
  const base = (env.erpApiUrl || "").replace(/\/$/, "");
  if (!key) return { synced: false, reason: "ERP_INTEGRATION_KEY not configured" };
  if (!base) return { synced: false, reason: "ERP_API_URL not configured" };
  try {
    const res = await fetch(`${base}/api/integrations/eos/engineering-requests/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-erp-integration-key": key,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) return { synced: false, error: data.error || `HTTP ${res.status}` };
    return { synced: true, ...data };
  } catch (e) {
    return { synced: false, error: e.message };
  }
}

module.exports = { notifyErpEngineeringSync };

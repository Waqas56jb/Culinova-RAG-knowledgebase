/**
 * ERP → EOS integration — engineering request handoff.
 * Authenticated via X-ERP-Integration-Key (server-to-server, no browser Origin).
 */
const express = require("express");
const { supabase } = require("../config/supabase");
const { env } = require("../config/env");
const { notifyErpEngineeringSync } = require("../lib/erpNotify");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));

const integrationKey = () => env.erpIntegrationKey || "";

function requireErpKey(req, res, next) {
  const key = req.headers["x-erp-integration-key"];
  const expected = integrationKey();
  if (!expected || key !== expected) {
    return res.status(401).json({ error: "Invalid integration key" });
  }
  next();
}

const STATUSES = [
  "Pending Engineering Review",
  "Under Design",
  "Awaiting Information",
  "Equipment Selection Completed",
  "Ready for Quotation",
];

router.use(requireErpKey);

router.post("/engineering-requests", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.erp_request_id) return res.status(422).json({ error: "erp_request_id is required" });
    const { data: existing } = await supabase.from("ceks_engineering_requests")
      .select("id").eq("erp_request_id", p.erp_request_id).maybeSingle();
    if (existing) return res.json({ id: existing.id, existing: true });

    const { data, error } = await supabase.from("ceks_engineering_requests").insert({
      erp_request_id: p.erp_request_id,
      erp_number: p.erp_number || null,
      customer: p.customer || null,
      project_name: p.project_name || null,
      project_type: p.project_type || null,
      project_location: p.project_location || null,
      drawings: p.drawings || [],
      attachments: Array.isArray(p.attachments) ? p.attachments : [],
      boq_text: p.boq_text || null,
      sales_notes: p.sales_notes || null,
      required_date: p.required_date || null,
      status: p.status || "Pending Engineering Review",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ id: data.id, synced: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/engineering-requests/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("ceks_engineering_requests")
      .select("*").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/engineering-requests/:id", async (req, res) => {
  try {
    const { data: existing } = await supabase.from("ceks_engineering_requests")
      .select("*").eq("id", req.params.id).maybeSingle();
    if (!existing) return res.status(404).json({ error: "Not found" });

    const patch = {};
    if (req.body.status && STATUSES.includes(req.body.status)) patch.status = req.body.status;
    if (req.body.approved_items) patch.approved_items = req.body.approved_items;
    if (req.body.ceks_project_id) patch.ceks_project_id = req.body.ceks_project_id;
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("ceks_engineering_requests")
      .update(patch).eq("id", req.params.id).select().single();
    if (error || !data) return res.status(404).json({ error: "Not found" });

    const erpSync = await notifyErpEngineeringSync({
      erp_request_id: data.erp_request_id,
      eos_request_id: data.id,
      status: data.status,
      approved_items: data.approved_items || [],
      ceks_project_id: data.ceks_project_id || null,
    });

    res.json({ ...data, _erp_sync: erpSync });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

/**
 * Admin-facing engineering request inbox — sales handoffs from Custom ERP.
 * Updates push back to ERP via server-to-server webhook (erpNotify).
 */
const express = require("express");
const auth = require("../services/auth");
const { supabase } = require("../config/supabase");
const { notifyErpEngineeringSync } = require("../lib/erpNotify");

const router = express.Router();

const STATUSES = [
  "Pending Engineering Review",
  "Under Design",
  "Awaiting Information",
  "Equipment Selection Completed",
  "Ready for Quotation",
];

router.use(auth.authRequired);

router.get("/", auth.requirePermission("project.read"), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ceks_engineering_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id", auth.requirePermission("project.read"), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ceks_engineering_requests")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id", auth.requirePermission("project.manage"), async (req, res) => {
  try {
    const { data: existing, error: e0 } = await supabase
      .from("ceks_engineering_requests")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (e0 || !existing) return res.status(404).json({ error: "Not found" });

    const body = req.body || {};
    const patch = { updated_at: new Date().toISOString() };

    if (body.status != null) {
      if (!STATUSES.includes(body.status)) {
        return res.status(422).json({ error: `Invalid status. Allowed: ${STATUSES.join(", ")}` });
      }
      patch.status = body.status;
    }
    if (body.approved_items != null) {
      if (!Array.isArray(body.approved_items)) {
        return res.status(422).json({ error: "approved_items must be an array" });
      }
      patch.approved_items = body.approved_items;
    }
    if (body.boq_text != null) patch.boq_text = body.boq_text;
    if (body.sales_notes != null) patch.sales_notes = body.sales_notes;
    if (body.ceks_project_id != null) patch.ceks_project_id = body.ceks_project_id;

    const { data, error } = await supabase
      .from("ceks_engineering_requests")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;

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

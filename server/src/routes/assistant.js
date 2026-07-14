const express = require("express");
const OpenAI = require("openai");
const { env } = require("../config/env");
const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("../utils/detail");
const auth = require("../services/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
const client = new OpenAI({ apiKey: env.openaiKey || "sk-placeholder-set-in-env" });

/**
 * The assistant is PUBLIC by design for APPROVED equipment — the client's portal reads approved
 * knowledge without a login, and asking the AI about it is part of reading it. But an UNAPPROVED
 * (draft/under-review) entry must NOT be answerable anonymously — that would expose data an engineer
 * has not signed off. So: approved → open; anything else → must be signed in with knowledge.read.
 * This also stops the OpenAI cost of drafts leaking to the public internet.
 */
async function gateEntry(req, res, next) {
  try {
    const { data: entry } = await supabase
      .from("ceks_knowledge_entries")
      .select("current_status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    if (entry.current_status === "approved") return next(); // public
    if (!req.user) return res.status(401).json({ error: "Sign in to ask about equipment that is not yet approved." });
    if (!(req.user.permissions || []).includes("knowledge.read")) {
      return res.status(403).json({ error: "You do not have permission to view this equipment." });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: "Something went wrong." });
  }
}

const SYSTEM =
  "You are an MEP engineering assistant for CULINOVA EOS. You answer ONLY using the equipment data provided, " +
  "which was extracted from the approved manufacturer documents for this model. If something is not in the data, " +
  "say it is not specified in the available documents — never invent values. Be concise, technical, and practical " +
  "for a site/MEP engineer. Cite the source document and page when relevant.\n" +
  "Format the answer in clean Markdown: use '## ' for section headings, '**bold**' for key terms, and '- ' bullet " +
  "lists for specifications. Keep it well-structured, scannable, and elegant. Leave a blank line between sections.";

function buildContext(d) {
  const m = d.model || {};
  let ctx =
    `EQUIPMENT: ${d.entry.title}\n` +
    `Brand: ${m.brand} | Category: ${m.category} | Type: ${m.equipment_type} | Series: ${m.series || "-"} | ` +
    `Model: ${m.model_number} | Power: ${m.power_type || "-"}\n` +
    `Description: ${d.entry.summary || ""}\n\nENGINEERING DATA (from approved documents):\n`;
  const bySec = {};
  (d.attributes || []).forEach((a) => { (bySec[a.attr_group] = bySec[a.attr_group] || []).push(a); });
  for (const [sec, rows] of Object.entries(bySec)) {
    ctx += `\n[${sec}]\n`;
    rows.forEach((a) => (ctx += `- ${a.name}: ${a.value ?? ""} ${a.unit ?? ""} (${a.source_document || "?"} p.${a.source_page ?? "?"})\n`));
  }
  if (d.notes?.length) { ctx += "\n[engineering notes]\n"; d.notes.forEach((n) => (ctx += `- ${n.content}\n`)); }
  ctx += "\nAVAILABLE DOCUMENTS: " + (d.documents || []).map((x) => x.doc_type).join(", ");
  return ctx;
}

async function answer(entryId, question) {
  const d = await getEntryDetail(entryId);
  if (!d) throw new Error("Entry not found");
  const resp = await client.chat.completions.create({
    model: env.extractionModel,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `${buildContext(d)}\n\nREQUEST: ${question}` },
    ],
  });
  return resp.choices[0]?.message?.content || "";
}

/** POST /api/entries/:id/ask  { question } */
router.post("/entries/:id/ask", gateEntry, async (req, res) => {
  try {
    const q = (req.body.question || "").trim();
    if (!q) return res.status(400).json({ error: "Question is required." });
    res.json({ answer: await answer(req.params.id, q) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/entries/:id/summary — installation summary */
router.post("/entries/:id/summary", gateEntry, async (req, res) => {
  try {
    res.json({ answer: await answer(req.params.id,
      "Generate a concise installation summary covering electrical, water/drain, gas, ventilation, and clearance requirements.") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/entries/:id/engineering-notes — generated engineering notes */
router.post("/entries/:id/engineering-notes", gateEntry, async (req, res) => {
  try {
    res.json({ answer: await answer(req.params.id,
      "List the key engineering design recommendations, operational recommendations, and limitations for installing and running this equipment.") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/entries/:id/checklist  { type: commissioning|maintenance|installation|method_statement } */
router.post("/entries/:id/checklist", gateEntry, async (req, res) => {
  try {
    const prompts = {
      commissioning: "Generate a numbered commissioning checklist for this equipment, grouped by discipline (electrical, water, drain, gas, ventilation). Each step must be verifiable and based only on the data provided.",
      maintenance: "Generate a numbered preventive-maintenance checklist for this equipment with suggested frequency per task, based only on the data provided.",
      installation: "Generate a numbered installation checklist for this equipment covering positioning, clearances, and each utility connection, based only on the data provided.",
      method_statement: "Write a concise installation method statement for this equipment: scope, prerequisites, step-by-step method per utility, and final verification. Base it only on the data provided.",
    };
    const type = prompts[req.body?.type] ? req.body.type : "commissioning";
    res.json({ type, answer: await answer(req.params.id, prompts[type]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PROJECT-LEVEL ASSISTANT (client item 17) — answers ONLY from the project's approved equipment
 * data and the approved CULINOVA recommendations. Every answer cites its equipment sources.
 */
const schedules = require("../services/schedules");

function projectContext(data) {
  let ctx = `PROJECT: ${data.project.name}${data.project.code ? ` (${data.project.code})` : ""}\n` +
    `Client: ${data.project.client || "-"} | Location: ${data.project.location || "-"} | Items: ${data.items.length}\n\n`;
  for (const loaded of data.items) {
    ctx += `── [${loaded.item.item_number || "?"}] ${loaded.entry.title} × ${loaded.item.qty || 1}` +
      `${loaded.item.area ? ` @ ${loaded.item.area}` : ""}\n`;
    const attrs = loaded.attributes.slice(0, 60);
    for (const a of attrs) {
      ctx += `   - ${a.name}: ${a.value ?? ""}${a.unit ? " " + a.unit : ""}` +
        `${a.source_document ? ` (${a.source_document}${a.source_page ? ", p." + a.source_page : ""})` : ""}\n`;
    }
    const recs = loaded.recommendations.filter((r) => !["rejected", "no_rule", "missing_input"].includes(r.status));
    if (recs.length) {
      ctx += `   CULINOVA RECOMMENDATIONS:\n`;
      for (const r of recs) {
        const v = r.final_value ?? r.value_text ?? r.value_num;
        if (v == null) continue;
        ctx += `   - ${v}${r.unit ? " " + r.unit : ""} [Rule ${r.rule_code || "?"} v${r.rule_version || "?"}, ${r.status}]\n`;
      }
    }
  }
  return ctx;
}

router.post("/projects/:id/ask", auth.authRequired, auth.requirePermission("project.read"), async (req, res) => {
  try {
    const q = (req.body.question || "").trim();
    if (!q) return res.status(400).json({ error: "Question is required." });
    const data = await schedules.loadProjectData(req.params.id);
    if (!data.items.length) return res.status(409).json({ error: "This project has no equipment yet." });

    const resp = await client.chat.completions.create({
      model: env.extractionModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM + "\nYou are answering about a PROJECT (a selection of equipment). When you state a value, name the equipment item (its item number and title) it comes from, and the CULINOVA rule when a recommendation is cited." },
        { role: "user", content: `${projectContext(data)}\n\nREQUEST: ${q}` },
      ],
    });
    res.json({ answer: resp.choices[0]?.message?.content || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

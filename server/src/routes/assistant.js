const express = require("express");
const OpenAI = require("openai");
const { env } = require("../config/env");
const { getEntryDetail } = require("../utils/detail");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
const client = new OpenAI({ apiKey: env.openaiKey || "sk-placeholder-set-in-env" });

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
router.post("/entries/:id/ask", async (req, res) => {
  try {
    const q = (req.body.question || "").trim();
    if (!q) return res.status(400).json({ error: "Question is required." });
    res.json({ answer: await answer(req.params.id, q) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/entries/:id/summary — installation summary */
router.post("/entries/:id/summary", async (req, res) => {
  try {
    res.json({ answer: await answer(req.params.id,
      "Generate a concise installation summary covering electrical, water/drain, gas, ventilation, and clearance requirements.") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/entries/:id/engineering-notes — generated engineering notes */
router.post("/entries/:id/engineering-notes", async (req, res) => {
  try {
    res.json({ answer: await answer(req.params.id,
      "List the key engineering design recommendations, operational recommendations, and limitations for installing and running this equipment.") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

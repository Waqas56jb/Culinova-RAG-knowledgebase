// ─────────────────────────────────────────────────────────────────────────────
// Shared engineering-section model — single source of truth for BOTH the admin
// reviewer app and the public client portal. Extracted here so the canonical
// checklist, the field-matching helpers, the row builder and the dynamic
// section resolver can never drift between the two apps.
// ─────────────────────────────────────────────────────────────────────────────

// Known engineering sections, in display order.
export const SECTIONS = [
  ["technical_specification", "Technical Specifications"],
  ["electrical", "Electrical Design"],
  ["water_drain", "Water / Drain Requirements"],
  ["gas", "Gas Requirements"],
  ["ventilation", "Ventilation Requirements"],
  ["dimensions_clearance", "Dimensions & Clearances"],
  ["connection_point", "MEP Connection Points"],
  ["installation", "Installation Requirements"],
  ["other", "Other"],
];

// Label used for the dynamic catch-all section that collects any attribute whose
// attr_group is not one of the known SECTIONS above, so nothing is ever hidden.
export const ADDITIONAL_SECTION_KEY = "__additional__";
export const ADDITIONAL_SECTION_LABEL = "Additional / Other";

// Canonical engineering checklist. Every field below is ALWAYS shown for its
// section — filled from extracted data, or left blank for the engineer to
// complete. { photo:true } fields accept a component photo upload.
export const REQUIRED_FIELDS = {
  technical_specification: ["Capacity", "Material", "Operating Temperature"],
  electrical: [
    "Voltage", "Frequency", "Total Power",
    "Socket Type", "Socket Rating", "Socket Installation Height (from finished floor)", { name: "Socket Photo", photo: true },
    "Isolator Switch Type", "Isolator Switch Rating", "Isolator Installation Height (from finished floor)", { name: "Isolator Switch Photo", photo: true },
    "Recommended Cable Size", "Recommended Circuit Breaker",
    "Cable Entry Location (Bottom / Rear / Top)", "Electrical Connection Position",
  ],
  water_drain: [
    "Cold Water Connection Type", "Cold Water Diameter", "Cold Water Height (from finished floor)",
    "Hot Water Connection Type", "Hot Water Diameter", "Hot Water Height (from finished floor)",
    "Drain Connection Type", "Drain Diameter", "Drain Height (from finished floor)", "Drain Method (Gravity / Pumped)",
  ],
  gas: [
    "Gas Connection Diameter", "Gas Connection Height (from finished floor)",
    "Gas Type (NG / LPG)", "Required Gas Pressure", "Gas Consumption",
  ],
  ventilation: [
    "Exhaust Airflow (CFM or m³/h)", "Fresh Air Requirement", "Heat Rejection", "Steam Exhaust Requirement", "Hood Requirement",
  ],
  dimensions_clearance: [
    "Overall Dimensions", "Machine Weight",
    "Rear Clearance", "Left Clearance", "Right Clearance", "Top Clearance", "Front Service Clearance", "Floor Fixing Requirements",
  ],
  connection_point: [],
  installation: ["Indoor / Outdoor", "Floor Requirements", "Mounting"],
  other: [],
};

export const REQ_LABEL = (f) => (typeof f === "string" ? f : f.name);
export const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const fieldMatch = (attrName, canonical) => {
  const a = normName(attrName), c = normName(canonical);
  if (!a || !c) return false;
  return a === c || a.startsWith(c) || c.startsWith(a);
};

// Merge extracted rows against the canonical checklist → complete, ordered
// display rows. Returns a canonical shape used by both apps:
//   { kind: "attr", a, photo?, extra? }   – a real attribute row
//   { kind: "missing", name, photo? }     – a blank required field
export function buildSectionRows(sectionKey, rows) {
  const req = REQUIRED_FIELDS[sectionKey] || [];
  const used = new Array(rows.length).fill(false);
  const out = [];
  for (const f of req) {
    const name = REQ_LABEL(f);
    const isPhoto = typeof f === "object" && f.photo;
    const matched = rows.map((a, i) => ({ a, i })).filter(({ a, i }) => !used[i] && fieldMatch(a.name, name));
    if (matched.length) {
      matched.forEach(({ i }) => (used[i] = true));
      matched.forEach(({ a }) => out.push({ kind: "attr", a, photo: isPhoto }));
    } else {
      out.push({ kind: "missing", name, photo: isPhoto });
    }
  }
  rows.forEach((a, i) => { if (!used[i]) out.push({ kind: "attr", a, extra: true }); });
  return out;
}

// Resolve the FULL ordered list of sections to render for a given set of grouped
// attributes. Known sections keep their fixed order and appear when they have
// canonical fields or actual data. Then EVERY remaining attr_group present in the
// data — anything not in SECTIONS, e.g. 'specification' or 'utility' — is collected
// into a single trailing "Additional / Other" section, so no attribute is ever
// hidden from the user.
//   groups: { [attr_group]: attribute[] }
//   → [{ key, label, rows, known }]
export function planSections(groups) {
  const g = groups || {};
  const knownKeys = new Set(SECTIONS.map(([k]) => k));
  const plan = [];

  for (const [key, label] of SECTIONS) {
    const rows = g[key] || [];
    if ((REQUIRED_FIELDS[key] || []).length > 0 || rows.length) {
      plan.push({ key, label, rows, known: true });
    }
  }

  const extraRows = [];
  for (const key of Object.keys(g)) {
    if (!knownKeys.has(key) && Array.isArray(g[key]) && g[key].length) extraRows.push(...g[key]);
  }
  if (extraRows.length) {
    plan.push({ key: ADDITIONAL_SECTION_KEY, label: ADDITIONAL_SECTION_LABEL, rows: extraRows, known: false });
  }

  return plan;
}

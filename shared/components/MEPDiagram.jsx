import React from "react";

/**
 * Simple MEP connection layout: equipment in the centre with labelled
 * Electrical / Water / Drain / Gas / Ventilation connection nodes around it.
 * Derives which connections exist from the extracted engineering sections.
 *
 * Accessibility: the SVG carries a generated <title>/<desc> (referenced via
 * aria-labelledby) enumerating every connection and its spec, and is paired with
 * an adjacent visually-hidden table so screen-reader users get the same layout
 * information the sighted diagram conveys.
 */
const COLORS = {
  electrical: "#1f4e79",
  water: "#2c7a7b",
  drain: "#6b4e9e",
  gas: "#b8621b",
  ventilation: "#2e7d5b",
};

// Visually hidden but available to assistive technology. Inlined so the shared
// component never depends on either app's stylesheet defining an sr-only class.
const SR_ONLY = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function find(rows, ...keys) {
  for (const k of keys) {
    const a = (rows || []).find((x) => x.name.toLowerCase().includes(k));
    if (a) return `${a.value ?? ""}${a.unit ? " " + a.unit : ""}`.trim();
  }
  return "";
}

const H = (rows) => find(rows, "height from finished floor", "installation height", "height from floor", "height");
const DIA = (rows) => find(rows, "diameter", "pipe size", "connection size", "size");
const TYPE = (rows) => find(rows, "connection type", "type");
function spec(rows) {
  const parts = [];
  const d = DIA(rows); if (d) parts.push("Ø " + d);
  const h = H(rows); if (h) parts.push("H " + h);
  const t = TYPE(rows); if (t) parts.push(t);
  return parts.join("  ");
}

export default function MEPDiagram({ groups, title }) {
  const g = groups || {};
  const nodes = [];
  const titleId = React.useId();
  const descId = React.useId();

  const elec = g.electrical || [];
  if (elec.length) {
    const v = find(elec, "voltage"); const ph = find(elec, "phase");
    nodes.push({ side: "left", type: "electrical", label: "Electrical", detail: [v, ph].filter(Boolean).join(" · ") || "Power supply", spec: spec(elec) });
  }
  const wd = g.water_drain || [];
  const water = wd.filter((a) => /water|inlet|flow|pressure/i.test(a.name) && !/drain/i.test(a.name));
  const drain = wd.filter((a) => /drain/i.test(a.name));
  if (water.length) nodes.push({ side: "right-top", type: "water", label: "Water", detail: TYPE(water) || "Water supply", spec: spec(water) });
  if (drain.length) nodes.push({ side: "right-bottom", type: "drain", label: "Drain", detail: find(drain, "method", "gravity", "pumped") || TYPE(drain) || "Drain", spec: spec(drain) });
  const gas = g.gas || [];
  if (gas.length) nodes.push({ side: "bottom", type: "gas", label: "Gas", detail: find(gas, "type") || "Gas supply", spec: spec(gas) });
  const vent = g.ventilation || [];
  const exhaust = (g.connection_point || []).filter((a) => /exhaust|fume|chimney|hood/i.test(a.name));
  if (vent.length || exhaust.length) nodes.push({ side: "top", type: "ventilation", label: "Ventilation", detail: find(vent, "exhaust", "airflow", "hood") || "Exhaust / hood", spec: spec(vent) });

  if (!nodes.length) return null;

  // fixed anchors per side (SVG 640 x 380)
  const BX = 230, BY = 140, BW = 180, BH = 100; // equipment box
  const anchors = {
    top: { nx: 320, ny: 40, ex: 320, ey: BY },
    left: { nx: 40, ny: 190, ex: BX, ey: 190 },
    bottom: { nx: 200, ny: 330, ex: 300, ey: BY + BH },
    "right-top": { nx: 600, ny: 150, ex: BX + BW, ey: 165 },
    "right-bottom": { nx: 600, ny: 250, ex: BX + BW, ey: 215 },
  };

  const equipment = (title || "Equipment").trim() || "Equipment";
  const summarize = (n) => [n.label, [n.detail, n.spec].filter(Boolean).join(" — ")].filter(Boolean).join(": ");
  const desc = `MEP connection layout for ${equipment}. ${nodes.map(summarize).join("; ")}.`;

  return (
    <>
      <svg viewBox="0 0 640 380" className="mep-svg" role="img" aria-labelledby={`${titleId} ${descId}`}>
        <title id={titleId}>{`MEP connection layout for ${equipment}`}</title>
        <desc id={descId}>{desc}</desc>
        {nodes.map((n) => {
          const a = anchors[n.side];
          return <line key={"l" + n.side} x1={a.nx} y1={a.ny} x2={a.ex} y2={a.ey} stroke={COLORS[n.type]} strokeWidth="2" strokeDasharray="4 3" />;
        })}
        {/* equipment box */}
        <rect x={BX} y={BY} width={BW} height={BH} rx="10" fill="#eef2f7" stroke="#1f4e79" strokeWidth="2" />
        <text x={BX + BW / 2} y={BY + BH / 2 - 6} textAnchor="middle" fontSize="13" fontWeight="700" fill="#0f2c4c">EQUIPMENT</text>
        <text x={BX + BW / 2} y={BY + BH / 2 + 14} textAnchor="middle" fontSize="10" fill="#556">{(title || "").slice(0, 26)}</text>
        {/* connection nodes */}
        {nodes.map((n) => {
          const a = anchors[n.side];
          const w = 162, h = n.spec ? 54 : 40;
          const x = Math.max(6, Math.min(640 - w - 6, n.side.startsWith("right") ? a.nx - w + 40 : n.side === "left" ? a.nx - 6 : a.nx - w / 2));
          const y = a.ny - h / 2;
          return (
            <g key={"n" + n.side}>
              <rect x={x} y={y} width={w} height={h} rx="7" fill="#fff" stroke={COLORS[n.type]} strokeWidth="1.5" />
              <rect x={x} y={y} width="6" height={h} rx="3" fill={COLORS[n.type]} />
              <text x={x + 14} y={y + 16} fontSize="11" fontWeight="700" fill={COLORS[n.type]}>{n.label}</text>
              <text x={x + 14} y={y + 31} fontSize="9.5" fill="#333">{(n.detail || "").slice(0, 28)}</text>
              {n.spec && <text x={x + 14} y={y + 45} fontSize="8.5" fill="#777">{n.spec.slice(0, 30)}</text>}
            </g>
          );
        })}
      </svg>
      <table style={SR_ONLY}>
        <caption>{`MEP connection layout for ${equipment}`}</caption>
        <thead>
          <tr><th scope="col">Connection</th><th scope="col">Detail</th><th scope="col">Specification</th></tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={"sr" + n.side}>
              <th scope="row">{n.label}</th>
              <td>{n.detail || "—"}</td>
              <td>{n.spec || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

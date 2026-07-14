import React from "react";

/** Lightweight, dependency-free markdown renderer:
 *  # / ## / ### headings, **bold**, `code`, - / * bullets, 1. numbered lists, paragraphs. */
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((p) => p !== "");
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={i} className="md-code">{p.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

export default function Markdown({ text }) {
  const lines = (text || "").split("\n");
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(list); list = null; } };

  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flush(); return; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { flush(); blocks.push({ type: "h", level: m[1].length, text: m[2] }); return; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (!list || list.type !== "ul") { flush(); list = { type: "ul", items: [] }; } list.items.push(m[1]); return; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (!list || list.type !== "ol") { flush(); list = { type: "ol", items: [] }; } list.items.push(m[1]); return; }
    flush(); blocks.push({ type: "p", text: line });
  });
  flush();

  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === "h") {
          const cls = b.level <= 2 ? "md-h md-h2" : "md-h md-h3";
          return <div key={i} className={cls}>{renderInline(b.text)}</div>;
        }
        if (b.type === "ul") return <ul key={i} className="md-ul">{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
        if (b.type === "ol") return <ol key={i} className="md-ol">{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>;
        return <p key={i} className="md-p">{renderInline(b.text)}</p>;
      })}
    </div>
  );
}

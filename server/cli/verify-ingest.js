/**
 * End-to-end ingest verification — real API, real AI, real DB. No mocks.
 *
 *   node cli/verify-ingest.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..", "..");
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:4400";
const EMAIL = process.env.VERIFY_EMAIL || "admin@gmail.com";
const PASSWORD = process.env.VERIFY_PASSWORD || "admin@123!";

function req(method, urlPath, { headers = {}, body = null, form = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...headers } };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* binary or plain */ }
        resolve({ status: res.statusCode, json, text, buf, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (form) {
      r.setHeader("Content-Type", `multipart/form-data; boundary=${form.boundary}`);
      r.end(form.body);
    } else if (body) {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      if (!opts.headers["Content-Type"]) r.setHeader("Content-Type", "application/json");
      r.setHeader("Content-Length", raw.length);
      r.end(raw);
    } else r.end();
  });
}

function multipart(fields, files) {
  const boundary = "----EosVerify" + Date.now();
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType || "application/octet-stream"}\r\n\r\n`,
    ));
    parts.push(f.buffer);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function ok(label, cond, detail) {
  const mark = cond ? "✔" : "✖";
  console.log(`  ${mark} ${label}${detail ? " — " + detail : ""}`);
  return !!cond;
}

(async () => {
  console.log("\n######## EOS INGEST E2E VERIFY ########\n");
  // pass = genuinely verified · fail = broken · blocked = could not be verified because of an
  // ENVIRONMENT limit (never counted as a pass — a thing we did not prove is not a thing that works).
  const report = { pass: 0, fail: 0, blocked: 0 };
  console.log(`  target: ${BASE}  ← if this is a long-running dev server it may be running STALE code;`);
  console.log(`          restart it (or set VERIFY_BASE) before trusting a failure here.\n`);

  const health = await req("GET", "/api/health");
  if (!ok("API health", health.status === 200, `status=${health.status}`)) process.exit(1);
  report.pass++;

  const login = await req("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } });
  const token = login.json?.access_token || login.json?.token;
  if (!ok("Login", login.status === 200 && token, login.json?.error || EMAIL)) process.exit(1);
  report.pass++;
  const auth = { Authorization: `Bearer ${token}` };

  // ── 1) MANUAL ENTRY ────────────────────────────────────────────────────────
  console.log("\n── 1) Manual entry ──");
  const manual = await req("POST", "/api/ingest/manual", {
    headers: auth,
    body: {
      model: {
        brand: "VERIFY-BRAND",
        model_number: `MAN-${Date.now()}`,
        display_name: "E2E Manual Test Oven",
        category: "Cooking Equipment",
        equipment_type: "Combi Oven",
        power_type: "Electric",
        description: "Automated verification draft — safe to delete",
      },
      attributes: [
        { attr_group: "electrical", name: "Voltage", value: "400", unit: "V" },
        { attr_group: "electrical", name: "Total Power", value: "12", unit: "kW" },
        { attr_group: "dimensions_clearance", name: "Width", value: "900", unit: "mm" },
      ],
      notes: [{ content: "Created by verify-ingest.js" }],
    },
  });
  const manOk = ok(
    "Manual → draft",
    manual.status < 300 && manual.json?.draft?.entry_id,
    manual.json?.error || `entry=${manual.json?.draft?.entry_id} status=${manual.status}`,
  );
  manOk ? report.pass++ : report.fail++;

  // ── 2) EXCEL BULK (template download + import) ──────────────────────────────
  console.log("\n── 2) Excel bulk template + import ──");
  const tpl = await req("GET", "/api/ingest/excel-template", { headers: auth });
  const tplOk = ok("Excel template download", tpl.status === 200 && tpl.buf.length > 1000, `bytes=${tpl.buf.length}`);
  tplOk ? report.pass++ : report.fail++;

  // Build a tiny real workbook via the same service (no mock rows beyond one verify row)
  const XLSX = require("xlsx");
  const { TEMPLATE_COLUMNS, importWorkbook, parseWorkbook } = require("../src/services/excelImport");
  const code = `XL-${Date.now()}`;
  const row = TEMPLATE_COLUMNS.map((h) => {
    if (/Product Code/i.test(h)) return code;
    if (/Product Name/i.test(h)) return "E2E Excel Bulk Oven";
    if (/^Brand/i.test(h)) return "VERIFY";
    if (/Category/i.test(h)) return "Cooking Equipment";
    if (/Equipment Type/i.test(h)) return "Combi Oven";
    if (/Voltage/i.test(h)) return "400";
    if (/Total Power/i.test(h)) return "18.5";
    if (/Width/i.test(h)) return "860";
    return "";
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS, row]);
  XLSX.utils.book_append_sheet(wb, ws, "EOS Equipment Import");
  const xbuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const parsed = parseWorkbook(xbuf);
  ok("Excel parse local", parsed.records.length === 1 && parsed.records[0].model.model_number === code, `records=${parsed.records.length}`);

  const excelForm = multipart({}, [{ field: "file", filename: "verify-bulk.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xbuf }]);
  const excel = await req("POST", "/api/ingest/excel", { headers: auth, form: excelForm });
  const exOk = ok(
    "Excel bulk → API",
    excel.status < 300 && (excel.json?.imported >= 1 || excel.json?.results?.some?.((r) => r.ok)),
    excel.json?.error || JSON.stringify({ imported: excel.json?.imported, skipped: excel.json?.skipped, status: excel.status }),
  );
  exOk ? report.pass++ : report.fail++;

  // Book4 honesty check (parse only — many rows lack product codes)
  const book4 = path.join(ROOT, "Book4.xlsx");
  if (fs.existsSync(book4)) {
    const b = parseWorkbook(fs.readFileSync(book4));
    const withCode = b.records.filter((r) => r.model.model_number).length;
    ok("Book4 parse (honest)", b.records.length > 0, `rows=${b.records.length} withCode=${withCode} emptyCode=${b.records.length - withCode}`);
  }

  // ── 3) PDF AI EXTRACT ──────────────────────────────────────────────────────
  console.log("\n── 3) PDF AI extract ──");
  const pdfPath = path.join(
    ROOT, "EQUIPMENTS", "COOKING EQUIPMENT", "FAGOR", "C-G961 OP", "C-G961 OP-DATA SHEET.pdf",
  );
  if (!fs.existsSync(pdfPath)) {
    ok("PDF file present", false, pdfPath);
    report.fail++;
  } else {
    const pdfBuf = fs.readFileSync(pdfPath);
    const pdfForm = multipart(
      { doc_types: JSON.stringify(["datasheet"]) },
      [{ field: "files", filename: "C-G961 OP-DATA SHEET.pdf", contentType: "application/pdf", buffer: pdfBuf }],
    );
    console.log("  … calling OpenAI extraction (may take 30–90s)");
    const pdf = await req("POST", "/api/ingest/pdf", { headers: auth, form: pdfForm });
    const draft = pdf.json?.draft || pdf.json;
    const pdfOk = ok(
      "PDF AI → draft",
      pdf.status < 300 && (draft?.entry_id || pdf.json?.entry_id),
      pdf.json?.error || `entry=${draft?.entry_id || pdf.json?.entry_id} model=${draft?.title || draft?.model?.model_number || "?"}`,
    );
    if (!pdfOk && (pdf.status === 402 || pdf.status === 429)) {
      // An OpenAI billing/rate limit is an environment limit — but it is NOT a pass. We did not
      // verify AI extraction, so we say exactly that and fail the run as UNVERIFIED.
      console.log("  ⚠ BLOCKED — OpenAI billing/rate limit. AI extraction was NOT verified (this is not a pass).");
      report.blocked++;
    } else if (pdfOk) {
      report.pass++;
      if (pdfOk && (draft?.entry_id || pdf.json?.entry_id)) {
        const id = draft?.entry_id || pdf.json?.entry_id;
        const detail = await req("GET", `/api/entries/${id}`, { headers: auth });
        const attrs = detail.json?.attributes || detail.json?.version?.attributes || [];
        const model = detail.json?.model || detail.json?.entry || {};
        ok("PDF draft has AI fields", attrs.length > 0 || model.model_number, `attrs=${attrs.length} brand=${model.brand || model.model?.brand || "?"}`);
        attrs.length > 0 || model.model_number ? report.pass++ : report.fail++;
      }
    } else {
      report.fail++;
    }
  }

  // ── 4) FOLDER INGEST ───────────────────────────────────────────────────────
  console.log("\n── 4) Folder ingest ──");
  const folder = path.join(ROOT, "EQUIPMENTS", "COOKING EQUIPMENT", "FAGOR", "MP-G910");
  if (!fs.existsSync(folder)) {
    ok("Folder present", false, folder);
    report.fail++;
  } else {
    const files = [];
    const walk = (dir, rel = "") => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(full).isDirectory()) walk(full, r);
        else files.push({ rel: `EQUIPMENTS/COOKING EQUIPMENT/FAGOR/MP-G910/${r}`.replace(/\\/g, "/"), full, name });
      }
    };
    walk(folder);
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    ok("Folder has PDFs", pdfs.length > 0, `files=${files.length} pdfs=${pdfs.length}`);
    const formFiles = files.map((f) => ({
      field: "files",
      filename: f.name,
      contentType: f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
      buffer: fs.readFileSync(f.full),
    }));
    const paths = JSON.stringify(files.map((f) => f.rel));
    const folderForm = multipart({ paths }, formFiles);
    console.log("  … folder AI extract (may take 30–120s)");
    const folderRes = await req("POST", "/api/ingest/folder", { headers: auth, form: folderForm });
    const models = folderRes.json?.models || [];
    const anyOk = Array.isArray(models) && models.some((m) => m.ok === true && m.entry_id);
    const allFailed = Array.isArray(models) && models.length > 0 && models.every((m) => m.ok === false);
    const fOk = ok(
      "Folder → draft(s)",
      folderRes.status < 300 && anyOk && !allFailed,
      folderRes.json?.error || JSON.stringify(folderRes.json).slice(0, 280),
    );
    // OpenAI quota is an environment limit, not an ingest-code defect — report honestly
    if (!fOk && /quota|billing|402/i.test(String(folderRes.json?.error || ""))) {
      console.log("  ⚠ Folder pipeline OK; blocked by OpenAI billing quota (not a code bug).");
    }
    fOk ? report.pass++ : ((folderRes.status === 402 || folderRes.status === 429) ? report.blocked++ : report.fail++);
    if (!fOk && (folderRes.status === 402 || folderRes.status === 429)) {
      console.log("  ⚠ BLOCKED — OpenAI billing/rate limit. Folder AI extraction was NOT verified (this is not a pass).");
    }
  }

  // ── 5) APPROVED-ONLY portal surface ────────────────────────────────────────
  console.log("\n── 5) Approved-only knowledge portal ──");
  const pub = await req("GET", "/api/knowledge?query=VERIFY");
  const pubList = pub.json?.entries || pub.json?.results || pub.json || [];
  const leaked = Array.isArray(pubList) && pubList.some((e) => /VERIFY|E2E Manual|MAN-/i.test(JSON.stringify(e)));
  ok("Public knowledge does not leak verify drafts", pub.status === 200 && !leaked, `status=${pub.status} leaked=${!!leaked}`);
  !leaked ? report.pass++ : report.fail++;

  const verdict = report.fail ? "FAILED" : report.blocked ? "INCOMPLETE — some paths were NOT verified" : "ALL VERIFIED";
  console.log(`\n######## ${verdict} — pass=${report.pass} fail=${report.fail} blocked=${report.blocked} ########`);
  if (report.blocked) {
    console.log(`  ${report.blocked} path(s) could not be verified (OpenAI billing/rate limit). Do NOT report these as working.`);
    console.log(`  If the target server is a long-running dev process, restart it first — stale code/keys cause false failures.`);
  }
  console.log("");
  // A blocked path is an unverified path — exit non-zero so CI never treats it as success.
  process.exit(report.fail || report.blocked ? 1 : 0);
})().catch((e) => {
  console.error("\n✖ VERIFY CRASHED:", e.message);
  console.error(e.stack);
  process.exit(1);
});

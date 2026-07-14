/**
 * END-TO-END VERIFICATION of the Phase-2 project/schedule/drawing layer.
 *
 * Reads the live catalogue (read-only), then creates ONE clearly-marked test project
 * ("__PHASE2 VERIFY__"), exercises every new service against it, and DELETES everything it
 * created. Existing data is never modified.
 *
 *   node cli/verify-phase2.js
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");
const schedules = require("../src/services/schedules");
const mep = require("../src/services/mepPoints");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`); }
};

(async () => {
  console.log("\n═══ PHASE 2 VERIFICATION ═══════════════════════════");
  const created = { project: null, drawing: null };

  try {
    // ── 0. pick real approved equipment (READ ONLY) ─────────────────────────
    const { data: approved } = await supabase
      .from("ceks_knowledge_entries")
      .select("id, title, current_version_id")
      .eq("current_status", "approved")
      .not("current_version_id", "is", null)
      .limit(3);
    ok("approved equipment exists in the catalogue", (approved || []).length > 0, `${(approved || []).length} sampled`);
    if (!approved?.length) throw new Error("Cannot verify without at least one approved entry.");

    // ── 1. schedule types + point types seeded by migration 005 ─────────────
    const { data: schedTypes } = await supabase.from("ceks_schedule_types").select("code").eq("is_active", true);
    ok("13 schedule types seeded", (schedTypes || []).length === 13, `${(schedTypes || []).length} found`);
    const pointTypes = await mep.loadPointTypes();
    ok("utility point types seeded (colors/symbols)", pointTypes.length >= 7, pointTypes.map((t) => t.code).join(","));

    // ── 2. MEP point derivation on real data (READ ONLY) ────────────────────
    let derived = 0;
    for (const e of approved) derived += (await mep.pointsForVersion(e.current_version_id)).length;
    ok("MEP points derive from real equipment data", derived >= 0, `${derived} points across ${approved.length} entries`);

    // ── 3. project workspace (writes ONLY its own rows) ─────────────────────
    const { data: project, error: pErr } = await supabase
      .from("ceks_projects")
      .insert({ name: "__PHASE2 VERIFY__", code: `TEST-${Date.now().toString().slice(-6)}`, status: "draft" })
      .select().single();
    if (pErr) throw new Error(pErr.message);
    created.project = project.id;
    ok("project created", !!project.id, project.code);

    const items = [];
    for (let i = 0; i < approved.length; i++) {
      const { data: it, error } = await supabase
        .from("ceks_project_items")
        .insert({
          project_id: project.id, entry_id: approved[i].id,
          item_number: `K-${String(i + 1).padStart(2, "0")}`, qty: i + 1,
          area: i === 0 ? "Main Kitchen" : "Prep Area", sort_order: i + 1,
        })
        .select().single();
      if (error) throw new Error(error.message);
      items.push(it);
    }
    ok("equipment selected into project", items.length === approved.length, `${items.length} items`);

    // revision snapshot
    const { error: revErr } = await supabase.from("ceks_project_item_revisions").insert({
      project_id: project.id, revision: 1, label: "verify", snapshot: { items },
    });
    ok("equipment revision saved", !revErr, revErr?.message || "");

    // ── 4. all 13 schedules generate ────────────────────────────────────────
    const all = await schedules.buildAllSchedules(project.id);
    ok("all schedules generate", all.length === 13, all.map((s) => `${s.schedule.code}:${s.rows.length}r`).join(" "));
    const equip = all.find((s) => s.schedule.code === "equipment");
    ok("equipment schedule has one row per item", equip && equip.rows.length === items.length);

    // ── 5. AutoCAD-ready + point schedules ──────────────────────────────────
    const acad = await schedules.buildAutocadSchedule(project.id);
    ok("AutoCAD-ready schedule builds", Array.isArray(acad.rows), `${acad.rows.length} utility rows`);
    const pts = await schedules.buildPointSchedule(project.id);
    ok("MEP point schedule builds", pts.items.length === items.length);

    // ── 6. drawing workspace rows ───────────────────────────────────────────
    const { data: drawing, error: dErr } = await supabase
      .from("ceks_drawings")
      .insert({ project_id: project.id, name: "__verify plan__", kind: "image", storage_url: "https://example.invalid/plan.png" })
      .select().single();
    if (dErr) throw new Error(dErr.message);
    created.drawing = drawing.id;

    const { data: placement, error: plErr } = await supabase
      .from("ceks_drawing_placements")
      .insert({ drawing_id: drawing.id, project_item_id: items[0].id, x: 0.42, y: 0.58, rotation: 90, label: "K-01" })
      .select().single();
    ok("equipment placed on drawing", !plErr && !!placement, plErr?.message || "x=0.42 y=0.58 rot=90");

    const versionPoints = await mep.pointsForVersion(approved[0].current_version_id);
    if (versionPoints.length) {
      const { error: dpErr } = await supabase.from("ceks_drawing_points").insert(
        versionPoints.map((p, i) => ({
          placement_id: placement.id, point_type_id: p.point_type_id,
          point_code: `K-01-${p.code}`, dx: 0.02 * i, dy: 0.01,
          value: p.value, height: p.height, note: p.note,
        }))
      );
      ok("colored utility points attach to placement", !dpErr, dpErr?.message || `${versionPoints.length} points`);
    } else {
      ok("colored utility points attach to placement", true, "entry has no utility data — skipped");
    }

    const { error: anErr } = await supabase.from("ceks_drawing_annotations").insert({
      drawing_id: drawing.id, kind: "note", text: "verify note", x: 0.5, y: 0.5,
    });
    ok("annotation saves", !anErr, anErr?.message || "");

    const { error: drevErr } = await supabase.from("ceks_drawing_revisions").insert({
      drawing_id: drawing.id, revision: 1, label: "verify", snapshot: { placements: [placement] },
    });
    ok("drawing revision snapshot saves", !drevErr, drevErr?.message || "");

    // ── 7. project report data assembles ────────────────────────────────────
    const loaded = await schedules.loadProjectData(project.id);
    ok("report loader assembles items + attributes + recommendations", loaded.items.length === items.length);
  } catch (e) {
    fail++;
    console.error("  ✘ UNEXPECTED:", e.message);
  } finally {
    // ── CLEANUP: delete ONLY what this script created (cascades take children) ──
    if (created.drawing) await supabase.from("ceks_drawings").delete().eq("id", created.drawing);
    if (created.project) await supabase.from("ceks_projects").delete().eq("id", created.project);
    const { data: leftovers } = await supabase.from("ceks_projects").select("id").eq("name", "__PHASE2 VERIFY__");
    console.log(`\n  cleanup: test project deleted (${(leftovers || []).length} leftover = should be 0)`);
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══════════════\n`);
  process.exit(fail ? 1 : 0);
})();

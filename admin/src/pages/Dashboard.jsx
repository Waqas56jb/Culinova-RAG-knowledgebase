import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { PageLoader, SkeletonKpiGrid } from "../components/Loader.jsx";

const KPI = {
  navy: {
    gradient: "linear-gradient(145deg, #6366f1 0%, #4f46e5 55%, #3730a3 100%)",
    glow: "rgba(99, 102, 241, 0.45)",
    bar: "#6366f1",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
  },
  grey: {
    gradient: "linear-gradient(145deg, #94a3b8 0%, #64748b 55%, #475569 100%)",
    glow: "rgba(100, 116, 139, 0.4)",
    bar: "#64748b",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  },
  gold: {
    gradient: "linear-gradient(145deg, #fbbf24 0%, #f59e0b 55%, #d97706 100%)",
    glow: "rgba(245, 158, 11, 0.45)",
    bar: "#f59e0b",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
  },
  green: {
    gradient: "linear-gradient(145deg, #34d399 0%, #10b981 55%, #059669 100%)",
    glow: "rgba(16, 185, 129, 0.45)",
    bar: "#10b981",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <path d="M22 4L12 14.01l-3-3" />
      </svg>
    ),
  },
  red: {
    gradient: "linear-gradient(145deg, #f87171 0%, #ef4444 55%, #dc2626 100%)",
    glow: "rgba(239, 68, 68, 0.4)",
    bar: "#ef4444",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
    ),
  },
};

const BAR_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6"];

function useCountUp(target, duration = 700) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (target == null) return;
    const t0 = performance.now();
    let frame;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - p) ** 3;
      setN(Math.round(target * eased));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return n;
}

export default function Dashboard({ onOpen }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminStats().then(setS).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="panel"><div className="alert">{error}</div></div>;

  if (!s) {
    return (
      <div className="dash">
        <header className="dash-hero">
          <div className="shimmer sk-title" />
          <div className="shimmer sk-sub" />
        </header>
        <SkeletonKpiGrid />
        <PageLoader label="Fetching dashboard metrics…" />
      </div>
    );
  }

  const st = s.byStatus || {};
  const approved = st.approved || 0;
  const total = s.total || 1;
  const cards = [
    { label: "Total models", value: s.total, cls: "navy", filter: { status: "all" } },
    { label: "Draft", value: st.draft || 0, cls: "grey", filter: { status: "draft" } },
    { label: "Under review", value: st.under_review || 0, cls: "gold", filter: { status: "under_review" } },
    { label: "Approved", value: approved, cls: "green", filter: { status: "approved" } },
    { label: "Rejected", value: st.rejected || 0, cls: "red", filter: { status: "rejected" } },
  ];

  return (
    <div className="dash">
      <header className="dash-hero">
        <div>
          <p className="dash-eyebrow">Overview</p>
          <h1 className="dash-title">Engineering knowledge</h1>
          <p className="dash-sub">
            {s.total} equipment models · {approved} published · click any card to explore
          </p>
        </div>
        <div className="dash-badge">
          <span className="dash-badge-dot" />
          Live data
        </div>
      </header>

      <div className="stat-cards">
        {cards.map((c) => (
          <KpiCard
            key={c.label}
            {...c}
            total={total}
            meta={KPI[c.cls]}
            onClick={() => onOpen({ status: "all", ...c.filter })}
          />
        ))}
      </div>

      <div className="breakdowns">
        <Breakdown title="Category" data={s.byCategory} field="category" onOpen={onOpen} icon="📦" />
        <Breakdown title="Brand" data={s.byBrand} field="brand" onOpen={onOpen} icon="🏷️" />
        <Breakdown title="Power type" data={s.byPowerType} field="power_type" onOpen={onOpen} icon="⚡" />
      </div>
    </div>
  );
}

function KpiCard({ label, value, cls, meta, total, onClick }) {
  const animated = useCountUp(value);
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <button
      type="button"
      className={"kpi-card kpi-" + cls}
      style={{ "--kpi-gradient": meta.gradient, "--kpi-glow": meta.glow }}
      onClick={onClick}
    >
      <div className="kpi-shine" aria-hidden />
      <div className="kpi-top">
        <span className="kpi-icon">{meta.icon}</span>
        <span className="kpi-pct">{pct}%</span>
      </div>
      <span className="kpi-value">{animated}</span>
      <span className="kpi-label">{label}</span>
      <div className="kpi-ring" aria-hidden>
        <svg viewBox="0 0 36 36">
          <circle className="kpi-ring-bg" cx="18" cy="18" r="15.9" />
          <circle
            className="kpi-ring-fill"
            cx="18"
            cy="18"
            r="15.9"
            strokeDasharray={`${pct} 100`}
          />
        </svg>
      </div>
    </button>
  );
}

function Breakdown({ title, data, field, onOpen, icon }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const total = entries.reduce((n, [, v]) => n + v, 0);

  return (
    <section className="breakdown-card">
      <div className="breakdown-head">
        <h2><span className="breakdown-icon">{icon}</span> {title}</h2>
        <span className="breakdown-total">{total}</span>
      </div>
      <div className="breakdown-list">
        {entries.length === 0 && <p className="muted">No data yet</p>}
        {entries.map(([k, v], i) => (
          <button
            key={k}
            type="button"
            className="bar-row clickable"
            style={{ "--bar-color": BAR_COLORS[i % BAR_COLORS.length] }}
            onClick={() => onOpen({ status: "all", [field]: k })}
          >
            <span className="bar-label" title={k}>{k || "—"}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${(v / max) * 100}%`, animationDelay: `${i * 60}ms` }}
              />
            </div>
            <span className="bar-value">{v}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

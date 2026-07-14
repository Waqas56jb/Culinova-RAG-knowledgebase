import React from "react";

export function Spinner({ size = "md", className = "" }) {
  return <span className={`spinner spinner-${size} ${className}`.trim()} aria-hidden />;
}

export function PageLoader({ label = "Loading…" }) {
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <Spinner size="lg" />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonKpiGrid({ count = 5 }) {
  return (
    <div className="stat-cards" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat-card skeleton-kpi">
          <div className="sk-icon shimmer" />
          <div className="sk-line sk-num shimmer" />
          <div className="sk-line sk-label shimmer" />
        </div>
      ))}
    </div>
  );
}

export function InlineLoader({ label = "Loading…" }) {
  return (
    <div className="inline-loader" role="status">
      <Spinner size="sm" />
      <span>{label}</span>
    </div>
  );
}

export function Btn({ loading, children, className = "", disabled, type = "button", ...props }) {
  return (
    <button
      type={type}
      className={`btn ${className}`.trim()}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner size="sm" className="btn-spinner" />}
      <span className="btn-label">{children}</span>
    </button>
  );
}

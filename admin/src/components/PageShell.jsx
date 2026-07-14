import React from "react";

const ACCENTS = {
  indigo: { emoji: "📚", label: "Knowledge" },
  emerald: { emoji: "📥", label: "Import" },
  amber: { emoji: "⚙️", label: "Rules" },
  violet: { emoji: "📖", label: "Dictionary" },
  cyan: { emoji: "🏗️", label: "Projects" },
  rose: { emoji: "👥", label: "Users" },
  teal: { emoji: "🔍", label: "Review" },
};

export function PageShell({ accent = "indigo", children }) {
  return <div className={`page page-accent-${accent}`}>{children}</div>;
}

export function PagePanel({ accent = "indigo", children, className = "" }) {
  return (
    <PageShell accent={accent}>
      <div className={`panel page-panel ${className}`.trim()}>{children}</div>
    </PageShell>
  );
}

export function PageHero({ accent, eyebrow, title, subtitle, meta, badge, actions, back }) {
  const accentMeta = ACCENTS[accent] || ACCENTS.indigo;
  return (
    <header className="page-hero">
      {back}
      <div className="page-hero-main">
        <p className="page-eyebrow">
          <span className="page-eyebrow-icon" aria-hidden>{accentMeta.emoji}</span>
          {eyebrow || accentMeta.label}
        </p>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
        {meta && <p className="page-meta">{meta}</p>}
      </div>
      {(badge || actions) && (
        <div className="page-hero-side">
          {badge}
          {actions && <div className="page-actions">{actions}</div>}
        </div>
      )}
    </header>
  );
}

export function SectionCard({ title, icon, children, className = "" }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {title && (
        <div className="section-head">
          {icon && <span className="section-icon">{icon}</span>}
          <h2>{title}</h2>
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon = "✨", title, text }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      {title && <strong>{title}</strong>}
      {text && <p className="muted">{text}</p>}
    </div>
  );
}

export function StatPill({ children, tone = "default" }) {
  return <span className={`stat-pill tone-${tone}`}>{children}</span>;
}

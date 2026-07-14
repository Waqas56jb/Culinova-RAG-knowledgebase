import React, { useEffect, useRef, useState } from "react";

/**
 * Accessible confirmation / prompt dialog — a drop-in replacement for the native
 * window.confirm / window.prompt, which are inaccessible and un-styleable.
 *
 * Renders a focus-trapped role="dialog" that is labelled by its title and
 * described by its message, closes on Escape or backdrop click, and restores
 * focus to the previously focused element on unmount. When `requireReason` is
 * set it shows a textarea and passes the entered reason to onConfirm.
 */
export default function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error = "",
  requireReason = false,
  reasonLabel = "Reason",
  reasonRequired = false,
  reasonPlaceholder = "",
  onConfirm,
  onCancel,
}) {
  const [reason, setReason] = useState("");
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  const restoreRef = useRef(null);
  const titleId = React.useId();
  const descId = React.useId();

  useEffect(() => {
    restoreRef.current = document.activeElement;
    // focus the reason field if present, otherwise the dialog itself
    const t = setTimeout(() => {
      (firstFieldRef.current || dialogRef.current)?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      if (restoreRef.current && restoreRef.current.focus) restoreRef.current.focus();
    };
  }, []);

  function onKeyDown(e) {
    if (e.key === "Escape") { e.stopPropagation(); onCancel && onCancel(); return; }
    if (e.key !== "Tab") return;
    // simple focus trap
    const focusables = dialogRef.current?.querySelectorAll(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables || !focusables.length) return;
    const list = Array.from(focusables);
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const reasonMissing = requireReason && reasonRequired && !reason.trim();

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel && onCancel(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? descId : undefined}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        {message && <p className="muted" id={descId}>{message}</p>}
        {requireReason && (
          <label className="wide">{reasonLabel}
            <textarea
              ref={firstFieldRef}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={reasonPlaceholder}
            />
          </label>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="decision">
          <button className="btn ghost" onClick={() => onCancel && onCancel()} disabled={busy}>{cancelLabel}</button>
          <button
            className={"btn " + (danger ? "danger" : "primary")}
            onClick={() => onConfirm && onConfirm(reason.trim())}
            disabled={busy || reasonMissing}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

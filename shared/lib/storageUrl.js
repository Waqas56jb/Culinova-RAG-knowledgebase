// ─────────────────────────────────────────────────────────────────────────────
// Storage-URL helpers shared by both apps.
//
// A document's `storage_url` may be either a relative path served by our own API
// or an absolute URL (Supabase public storage, or — for Excel-imported records —
// an arbitrary externally supplied link). Anything we drop into an <iframe> must
// therefore be validated against a trusted-host allowlist first; an untrusted or
// non-http(s) URL (e.g. `javascript:` / `data:`) must never be framed.
// ─────────────────────────────────────────────────────────────────────────────

// Resolve a possibly-relative storage_url to an absolute URL against the API base.
export function resolveStorageUrl(storageUrl, apiBase) {
  if (!storageUrl) return "";
  return /^https?:\/\//i.test(storageUrl) ? storageUrl : `${apiBase || ""}${storageUrl}`;
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

// Hosts we trust to render inside an <iframe>: our own API host (which serves
// relative uploads), Supabase storage where documents live, plus any additional
// hosts configured via the VITE_TRUSTED_STORAGE_HOSTS build-time env var
// (comma-separated) or passed explicitly.
function trustedHostSuffixes(apiBase, extraHosts) {
  const list = [];
  const api = hostOf(apiBase);
  if (api) list.push(api);
  try {
    const env = (import.meta.env && import.meta.env.VITE_TRUSTED_STORAGE_HOSTS) || "";
    env.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).forEach((h) => list.push(h));
  } catch {}
  (extraHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean).forEach((h) => list.push(h));
  return list;
}

// True when `storageUrl`, once resolved against `apiBase`, is safe to load in an
// <iframe>: it must be http(s) and its host must be the API host, a Supabase
// storage host, or an explicitly trusted host.
export function isFramableStorageUrl(storageUrl, apiBase, extraHosts) {
  const full = resolveStorageUrl(storageUrl, apiBase);
  if (!full) return false;
  let u;
  try { u = new URL(full); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.host.toLowerCase();
  if (host.endsWith(".supabase.co") || host.endsWith(".supabase.in")) return true;
  return trustedHostSuffixes(apiBase, extraHosts).includes(host);
}

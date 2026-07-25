/**
 * PostgREST filter-string safety.
 *
 * Supabase's `.or("col.ilike.%x%,other.ilike.%x%")` builds a FILTER GRAMMAR from a string. The
 * characters , . : ( ) are structural in that grammar and % / * are wildcards, so interpolating raw
 * user input lets a caller inject filter logic (or a denial-of-service pattern). We neutralise the
 * structural characters and cap the length; the remaining plain text is safe to wrap in ilike.
 */
function sanitizeSearch(raw, max = 100) {
  return String(raw == null ? "" : raw)
    .replace(/[,.()%*:"'\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Build a safe PostgREST `.or()` ilike clause that PRESERVES dotted model codes (TBS.180, COS.2404-2).
 *
 * The bug this fixes: sanitizeSearch() strips "." to a space, so searching "TBS.180" became
 * "TBS 180" and `code.ilike.%TBS 180%` matched nothing. Here the value is DOUBLE-QUOTED — which is
 * exactly how PostgREST lets its structural characters ( , . : ( ) ) appear literally in a filter
 * value — so "TBS.180" stays "TBS.180" and matches. We strip only what quoting cannot tame: the
 * double-quote / backslash (break-out) and the LIKE wildcards % * (injection / DoS).
 *
 * Columns are supplied by the caller — nothing about the schema is hardcoded.
 * @param {string[]} columns e.g. ["title","code","model_number"]
 * @param {string} raw user text
 * @returns {string|null} a clause for `.or(...)`, or null when there is nothing to search
 */
function buildOrIlike(columns, raw, max = 100) {
  const v = String(raw == null ? "" : raw)
    .replace(/["\\%*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  if (!v || !columns || !columns.length) return null;
  return columns.map((c) => `${c}.ilike."%${v}%"`).join(",");
}

module.exports = { sanitizeSearch, buildOrIlike };

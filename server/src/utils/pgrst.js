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

module.exports = { sanitizeSearch };

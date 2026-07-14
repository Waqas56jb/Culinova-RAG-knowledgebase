const { supabase } = require("../config/supabase");
const { env } = require("../config/env");

// Bucket + privacy are configuration. Default is a PUBLIC bucket (the portal shows approved
// manufacturer datasheets by direct URL). Set STORAGE_PRIVATE=true to create a PRIVATE bucket and
// serve every object through a short-lived signed URL instead — see urlForKey(). Flipping an EXISTING
// public bucket to private is a coordinated migration (re-point stored URLs to keys + read paths use
// urlForKey), not just this flag, because the URLs already saved in the DB would otherwise 404.
const BUCKET = env.storageBucket;
const PRIVATE = env.storagePrivate;
const SIGNED_TTL = env.storageSignedTtl;

let ensured = false;

/** Ensure the storage bucket exists, with the configured visibility. Created once. */
async function ensureBucket() {
  if (ensured) return;
  try {
    const { data } = await supabase.storage.getBucket(BUCKET);
    if (!data) await supabase.storage.createBucket(BUCKET, { public: !PRIVATE });
  } catch {
    try { await supabase.storage.createBucket(BUCKET, { public: !PRIVATE }); } catch {}
  }
  ensured = true;
}

/**
 * A servable URL for a stored object key:
 *   • public bucket  → the stable public URL
 *   • private bucket → a signed URL that expires after SIGNED_TTL seconds
 * Read paths that hold an object KEY should call this so proprietary files are never world-readable
 * when the bucket is private.
 */
async function urlForKey(key) {
  if (PRIVATE) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(key, SIGNED_TTL);
    if (error) throw new Error("storage sign: " + error.message);
    return data.signedUrl;
  }
  return supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
}

/** Upload any buffer to Supabase Storage at `key`; returns a servable URL (public or signed). */
async function uploadBuffer(key, buffer, contentType) {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
    contentType: contentType || "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error("storage upload: " + error.message);
  return urlForKey(key);
}

/** Upload a PDF buffer to Supabase Storage; returns a servable URL. */
async function uploadPdf(id, buffer) {
  return uploadBuffer(`pdfs/${id}.pdf`, buffer, "application/pdf");
}

module.exports = { uploadPdf, uploadBuffer, ensureBucket, urlForKey, BUCKET, PRIVATE };

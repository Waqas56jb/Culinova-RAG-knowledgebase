const { supabase } = require("../config/supabase");

const BUCKET = "ceks-files";
let ensured = false;

/** Ensure the public storage bucket exists (created once). */
async function ensureBucket() {
  if (ensured) return;
  try {
    const { data } = await supabase.storage.getBucket(BUCKET);
    if (!data) {
      await supabase.storage.createBucket(BUCKET, { public: true });
    }
  } catch {
    try { await supabase.storage.createBucket(BUCKET, { public: true }); } catch {}
  }
  ensured = true;
}

/** Upload any buffer to Supabase Storage at `key`; returns a public URL. */
async function uploadBuffer(key, buffer, contentType) {
  await ensureBucket();
  const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
    contentType: contentType || "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error("storage upload: " + error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

/** Upload a PDF buffer to Supabase Storage; returns a public URL. */
async function uploadPdf(id, buffer) {
  return uploadBuffer(`pdfs/${id}.pdf`, buffer, "application/pdf");
}

module.exports = { uploadPdf, uploadBuffer, ensureBucket, BUCKET };

// Shared fetch-response handler used by both apps' api clients.
// On a non-2xx response it extracts the server's { error } message (falling back
// to the status text), throws an Error carrying the HTTP status, and otherwise
// resolves the parsed JSON body.
export async function j(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

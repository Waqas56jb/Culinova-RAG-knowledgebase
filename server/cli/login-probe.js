/**
 * MANUAL probe — signs in against a server you are already running, to check credentials by hand.
 * Run it yourself:  node cli/login-probe.js
 *
 * This is NOT part of the automated suite and must never be. It needs a live server on port 4400,
 * so it can only pass on a developer machine. It used to be called "test-login.js", and Node's test
 * runner auto-discovers anything matching "test-*.js" — so `npm test` ran it, which passed locally
 * (a dev server was up) and failed CI with ECONNREFUSED. Hence the name: keep manual probes out of
 * the test-* / *-test / *.test naming patterns, or CI will adopt them as tests.
 */
require("dotenv").config();
(async () => {
  const r = await fetch("http://localhost:4400/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@gmail.com", password: "admin@123!" }),
  });
  const text = await r.text();
  console.log("Status:", r.status, r.statusText);
  try {
    const j = JSON.parse(text);
    console.log(j.access_token ? "LOGIN OK" : "Response:", JSON.stringify(j, null, 2));
  } catch {
    console.log("Body (not JSON):", text.slice(0, 300));
  }
})();

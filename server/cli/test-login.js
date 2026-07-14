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

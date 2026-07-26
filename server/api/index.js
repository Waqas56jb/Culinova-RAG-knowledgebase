// Vercel serverless entry — exports the Express app as the function handler.
module.exports = require("../src/index.js");
// Give AI extraction room to finish inside one request (Vercel's default cap is short). 60s is within
// both the Hobby and Pro plan limits, so it can never fail the deploy; because the UI now uploads ONE
// PDF per request (a sequential queue), every call stays comfortably under this.
module.exports.config = { maxDuration: 60 };

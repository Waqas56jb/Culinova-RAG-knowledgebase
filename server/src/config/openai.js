const OpenAI = require("openai");
const { env } = require("./env");

/**
 * The shared OpenAI client, built LAZILY on first use.
 *
 * Building it eagerly at module load was a deployment landmine: the OpenAI SDK THROWS in its
 * constructor when no API key is present, so a missing OPENAI_API_KEY crashed the ENTIRE server at
 * startup (FUNCTION_INVOCATION_FAILED on serverless) — taking down auth, rules, standards and every
 * other route that never touches OpenAI. Now the client is created only when an AI feature actually
 * runs: a missing key fails just that call with a clear 503, and the rest of the API stays up.
 *
 * Timeout and retry come from config so an OpenAI call can never hang a request or run up unbounded
 * cost. There is deliberately no placeholder key — the failure is explicit, not deferred to an
 * opaque 401.
 */
let client = null;

function getOpenAI() {
  if (client) return client;
  if (!env.openaiKey) {
    throw Object.assign(
      new Error("OPENAI_API_KEY is not configured. Set it to use AI extraction, embeddings, or the assistant."),
      { status: 503 }
    );
  }
  client = new OpenAI({
    apiKey: env.openaiKey,
    timeout: env.openaiTimeoutMs,
    maxRetries: env.openaiMaxRetries,
  });
  return client;
}

module.exports = { getOpenAI };

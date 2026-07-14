const OpenAI = require("openai");
const { env } = require("./env");

/**
 * ONE configured OpenAI client for the whole server.
 *
 * Timeout and retry come from config (env.openaiTimeoutMs / env.openaiMaxRetries). Until now those
 * values were declared and commented as critical but never wired into any client, so every OpenAI
 * call was unbounded — a hung request could hang the whole route, and a flaky call had no ceiling on
 * cost. There is deliberately NO "sk-placeholder" fallback: a missing key should fail fast and
 * clearly at call time (env.assertConfig already warns at boot), not defer to an opaque 401.
 */
const openai = new OpenAI({
  apiKey: env.openaiKey,
  timeout: env.openaiTimeoutMs,
  maxRetries: env.openaiMaxRetries,
});

module.exports = { openai };

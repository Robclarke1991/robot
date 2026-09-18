// api/chat.js — the robot's brain, server side.
//
// The Anthropic API key lives here as an environment variable and never
// reaches the phone. The page POSTs { model, system, messages } to /api/chat
// and gets Claude's reply straight back.
//
// Environment variables to set in Vercel:
//   ANTHROPIC_API_KEY   (required)  your Robot-workspace key
//   ALLOWED_ORIGIN      (optional)  e.g. https://robot.mylittlestories.co.uk
//                                   blocks other websites calling your endpoint

export const config = { maxDuration: 60 };   // web searches take a few seconds

// Only these models can be requested, whatever the page asks for.
const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6"
];

const MAX_TOKENS = 1200;    // web search results need headroom; the prompt keeps replies short
const HARD_MAX  = 4000;     // stories need more, but not unlimited
const MAX_MESSAGES = 16;     // cap the history a caller can push

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // Only serve our own page, if we've been told what that is.
  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.origin;
  if (allowed && origin && origin !== allowed) {
    return res.status(403).json({ error: "Not allowed from this origin" });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server has no ANTHROPIC_API_KEY set" });
  }

  const body = req.body || {};
  const messages = body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: "too many messages" });
  }

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : ALLOWED_MODELS[0];

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, HARD_MAX),
        system: typeof body.system === "string" ? body.system : undefined,
        messages,
        // Web search lets him answer anything that depends on today — weather,
        // local events, share prices. Skipped for camera calls, which never
        // need it and are faster and cheaper without the tool attached.
        tools: body.search === false ? undefined : [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3
        }]
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      // Pass the status through so the robot can say something useful,
      // but don't leak anything about the key itself.
      console.error("Anthropic error", upstream.status, data);
      return res.status(upstream.status).json({
        error: { message: (data && data.error && data.error.message) || "Upstream error" }
      });
    }

    return res.status(200).json(data);

  } catch (e) {
    console.error("Proxy failure", e);
    return res.status(502).json({ error: { message: "Could not reach Claude" } });
  }
}

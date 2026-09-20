// AI Citation Test — Netlify Edge Function (PREMIUM TIER, costs real API money)
// Queries ChatGPT, Claude, Perplexity, and Gemini with a real question and
// checks whether/how they mention a specific business. This is the paid-audit
// layer, separate from the free /api/aeo-audit scan on purpose:
//   1. It costs money per run (web-search-enabled API calls, roughly
//      low-single-digit cents to ~$0.05-0.15 total across 4 providers per
//      question depending on models/providers chosen — verify against each
//      provider's current pricing before relying on a number).
//   2. It's gated behind ADMIN_KEY so the public free-scan page can never
//      trigger it and run up your bill.
//
// HONESTY NOTE (read before relying on this in front of a client):
// The per-provider parsing logic below (parseOpenAI/parseAnthropic/
// parsePerplexity/parseGemini) is unit-tested against realistic MOCKED
// response shapes built from each provider's documented API format —
// 16/16 tests passing. The actual live network calls to four paid,
// frequently-changing provider APIs could NOT be verified end-to-end here,
// since that requires your real API keys and spends your real money.
// Provider response shapes and model names do drift — run one real test
// against a business you know the answer for before trusting this in front
// of a paying client, and check this file's TODO comments (model name
// defaults) against current provider docs first.
//
// Required env vars (set only the ones you want active — missing keys are
// skipped cleanly, not treated as errors):
//   ADMIN_KEY            - shared secret required as ?key= to call this at all
//   OPENAI_API_KEY        + optional OPENAI_MODEL (default below)
//   ANTHROPIC_API_KEY     + optional ANTHROPIC_MODEL
//   PERPLEXITY_API_KEY    + optional PERPLEXITY_MODEL (default "sonar")
//   GOOGLE_AI_API_KEY      + optional GEMINI_MODEL

// ---------------------------------------------------------------------------
// Pure parsing logic (unit-tested — 16/16 passing against mocked responses
// matching each provider's documented shape as of the research behind this
// build; see the module header above for what that testing did and didn't cover)
// ---------------------------------------------------------------------------

function findMention(text, businessName) {
  if (!text || !businessName) return { mentioned: false, snippet: null };
  const idx = text.toLowerCase().indexOf(businessName.toLowerCase());
  if (idx === -1) return { mentioned: false, snippet: null };
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + businessName.length + 60);
  return { mentioned: true, snippet: (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "") };
}

function domainMentionedInCitations(citations, domain) {
  if (!domain || !citations || !citations.length) return false;
  const bareDomain = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase();
  return citations.some((c) => (c.url || "").toLowerCase().includes(bareDomain));
}

function parseOpenAI(responseJson) {
  const text = responseJson.output_text || extractOpenAIText(responseJson);
  const citations = [];
  (responseJson.output || []).forEach((item) => {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((c) => {
        (c.annotations || []).forEach((a) => {
          if (a.type === "url_citation") citations.push({ url: a.url, title: a.title });
        });
      });
    }
  });
  return { text, citations };
}
function extractOpenAIText(responseJson) {
  let text = "";
  (responseJson.output || []).forEach((item) => {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((c) => { if (c.type === "output_text") text += c.text; });
    }
  });
  return text;
}

function parseAnthropic(responseJson) {
  let text = "";
  const citations = [];
  (responseJson.content || []).forEach((block) => {
    if (block.type === "text") text += block.text;
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      block.content.forEach((r) => {
        if (r.type === "web_search_result") citations.push({ url: r.uri || r.url, title: r.title });
      });
    }
  });
  return { text, citations };
}

function parsePerplexity(responseJson) {
  const text = responseJson?.choices?.[0]?.message?.content || "";
  const citations = (responseJson.citations || []).map((url) => ({ url, title: null }));
  return { text, citations };
}

function parseGemini(responseJson) {
  const candidate = (responseJson.candidates || [])[0] || {};
  const text = (candidate.content?.parts || []).map((p) => p.text || "").join("");
  const chunks = candidate.groundingMetadata?.groundingChunks || [];
  const citations = chunks.filter((c) => c.web).map((c) => ({ url: c.web.uri, title: c.web.title }));
  return { text, citations };
}

// ---------------------------------------------------------------------------
// Fetch orchestration — NOT unit-tested (needs real paid keys); defensive by
// design so one provider failing/erroring never breaks the others.
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runOpenAI(question, businessName, domain) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return { engine: "ChatGPT (OpenAI)", configured: false };
  // TODO before relying on this: confirm this model id is still current in
  // OpenAI's docs — model names in this family have moved fast (verify at
  // platform.openai.com/docs/models). Override via OPENAI_MODEL env var
  // without a redeploy if it's changed.
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o";
  try {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, tools: [{ type: "web_search" }], input: question }),
      },
      25000
    );
    if (!res.ok) return { engine: "ChatGPT (OpenAI)", configured: true, error: `HTTP ${res.status}` };
    const data = await res.json();
    const { text, citations } = parseOpenAI(data);
    const mention = findMention(text, businessName);
    return { engine: "ChatGPT (OpenAI)", configured: true, model, ...mention, citations, citedWithLink: domainMentionedInCitations(citations, domain) };
  } catch (e) {
    return { engine: "ChatGPT (OpenAI)", configured: true, error: e.message || "request failed" };
  }
}

async function runAnthropic(question, businessName, domain) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { engine: "Claude (Anthropic)", configured: false };
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5";
  try {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: question }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        }),
      },
      25000
    );
    if (!res.ok) return { engine: "Claude (Anthropic)", configured: true, error: `HTTP ${res.status}` };
    const data = await res.json();
    const { text, citations } = parseAnthropic(data);
    const mention = findMention(text, businessName);
    return { engine: "Claude (Anthropic)", configured: true, model, ...mention, citations, citedWithLink: domainMentionedInCitations(citations, domain) };
  } catch (e) {
    return { engine: "Claude (Anthropic)", configured: true, error: e.message || "request failed" };
  }
}

async function runPerplexity(question, businessName, domain) {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return { engine: "Perplexity", configured: false };
  const model = Deno.env.get("PERPLEXITY_MODEL") || "sonar";
  try {
    const res = await fetchWithTimeout(
      "https://api.perplexity.ai/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: question }] }),
      },
      25000
    );
    if (!res.ok) return { engine: "Perplexity", configured: true, error: `HTTP ${res.status}` };
    const data = await res.json();
    const { text, citations } = parsePerplexity(data);
    const mention = findMention(text, businessName);
    return { engine: "Perplexity", configured: true, model, ...mention, citations, citedWithLink: domainMentionedInCitations(citations, domain) };
  } catch (e) {
    return { engine: "Perplexity", configured: true, error: e.message || "request failed" };
  }
}

async function runGemini(question, businessName, domain) {
  const key = Deno.env.get("GOOGLE_AI_API_KEY");
  if (!key) return { engine: "Gemini (Google AI Overviews proxy)", configured: false };
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: question }] }], tools: [{ google_search: {} }] }),
      },
      25000
    );
    if (!res.ok) return { engine: "Gemini (Google AI Overviews proxy)", configured: true, error: `HTTP ${res.status}` };
    const data = await res.json();
    const { text, citations } = parseGemini(data);
    const mention = findMention(text, businessName);
    return { engine: "Gemini (Google AI Overviews proxy)", configured: true, model, ...mention, citations, citedWithLink: domainMentionedInCitations(citations, domain) };
  } catch (e) {
    return { engine: "Gemini (Google AI Overviews proxy)", configured: true, error: e.message || "request failed" };
  }
}

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const reqUrl = new URL(request.url);
  const adminKey = Deno.env.get("ADMIN_KEY");
  if (!adminKey) {
    return json({ error: "This endpoint is not configured (no ADMIN_KEY set) — it refuses to run rather than run unprotected." }, 503);
  }
  if (reqUrl.searchParams.get("key") !== adminKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  const question = (reqUrl.searchParams.get("question") || "").trim();
  const businessName = (reqUrl.searchParams.get("businessName") || "").trim();
  const domain = (reqUrl.searchParams.get("domain") || "").trim();

  if (!question || !businessName) {
    return json({ error: "Missing required ?question= and ?businessName= parameters." }, 400);
  }

  const results = await Promise.all([
    runOpenAI(question, businessName, domain),
    runAnthropic(question, businessName, domain),
    runPerplexity(question, businessName, domain),
    runGemini(question, businessName, domain),
  ]);

  const configured = results.filter((r) => r.configured);
  const mentioned = configured.filter((r) => r.mentioned);

  return json({
    question,
    businessName,
    domain: domain || null,
    results,
    summary: {
      providersConfigured: configured.length,
      providersMentioning: mentioned.length,
      citationRate: configured.length ? Math.round((mentioned.length / configured.length) * 100) : null,
    },
    generatedAt: new Date().toISOString(),
  });
};

export const config = { path: "/api/aeo-citation-test" };

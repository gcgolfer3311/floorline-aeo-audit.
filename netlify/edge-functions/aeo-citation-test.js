// AI Visibility Audit — AI citation test — /api/aeo-citation-test
// Asks ChatGPT, Claude, Perplexity and Gemini a customer-style question and
// checks whether the business is named or linked in each answer.
//
// COSTS MONEY: each run makes up to 4 paid API calls. Two ways in:
//   • Admin  — GET ?key=ADMIN_KEY&question=&businessName=&domain=   (no limits)
//   • Public — POST {"leadToken": "..."} from /api/aeo-lead            (limited)
// Public limits: 1 run per lead, 2 runs per email per day, and a global daily
// cap (env CITATION_DAILY_CAP, default 30). A repeat call with the same lead
// token returns the saved result instead of spending money again.
//
// Env: OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY
// (any subset — missing engines show "Not configured"), ADMIN_KEY, and
// optional OPENAI_MODEL / ANTHROPIC_MODEL / PERPLEXITY_MODEL / GEMINI_MODEL.
import { getStore } from "@netlify/blobs";
import { runCitationTest, PROVIDERS } from "../lib/aeo-core.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const env = (k) => { try { return Netlify.env.get(k) || ""; } catch { return ""; } };

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const configuredCount = () => PROVIDERS.filter((p) => env(p.keyEnv)).length;

async function bump(store, key) {
  const cur = (await store.get(key, { type: "json" })) || { n: 0 };
  cur.n += 1;
  await store.setJSON(key, cur);
  return cur.n;
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  // ---------------- Admin mode ----------------
  if (request.method === "GET") {
    const p = new URL(request.url).searchParams;
    const adminKey = env("ADMIN_KEY");
    if (!adminKey) return json({ error: "ADMIN_KEY is not set on this site." }, 503);
    if (!safeEqual(p.get("key"), adminKey)) return json({ error: "Invalid access key." }, 401);
    const question = (p.get("question") || "").trim().slice(0, 200);
    const businessName = (p.get("businessName") || "").trim().slice(0, 100);
    const domain = (p.get("domain") || "").trim().slice(0, 200);
    if (!question || !businessName) return json({ error: "question and businessName are required." }, 400);
    const result = await runCitationTest({ question, businessName, domain, getEnv: env, fetchImpl: fetch });
    return json(result);
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ---------------- Public (lead-gated) mode ----------------
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const token = String((body && body.leadToken) || "");
  if (!/^[a-f0-9]{32}$/.test(token)) return json({ error: "Missing or invalid access token." }, 400);

  let leads, limits;
  try {
    leads = getStore("aeo-leads");
    limits = getStore("aeo-limits");
  } catch {
    return json({ error: "Storage unavailable." }, 503);
  }
  const lead = await leads.get(token, { type: "json" });
  if (!lead) return json({ error: "That link has expired. Run the scan again." }, 404);
  if (lead.citation) return json({ ...lead.citation, cached: true });

  if (!configuredCount()) {
    return json({ error: "unavailable", message: "The live AI check is offline right now — we got your request and will send your results personally." }, 503);
  }

  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env("CITATION_DAILY_CAP")) || 30;
  const globalKey = `global-${day}`;
  const emailKey = `email-${await sha(lead.email)}-${day}`;
  const g = (await limits.get(globalKey, { type: "json" })) || { n: 0 };
  const e = (await limits.get(emailKey, { type: "json" })) || { n: 0 };
  if (g.n >= cap) return json({ error: "limit", message: "Today's free AI checks are used up — we got your request and will send your results personally." }, 429);
  if (e.n >= 2) return json({ error: "limit", message: "You've used today's free AI checks. We'll follow up with the full picture." }, 429);

  // Count before spending, so parallel retries can't overspend.
  await bump(limits, globalKey);
  await bump(limits, emailKey);

  const result = await runCitationTest({ question: lead.question, businessName: lead.businessName, domain: lead.url, getEnv: env, fetchImpl: fetch });

  // Every engine failed (outage, bad key): don't burn the lead's one free run.
  if (!result.summary.providersAnswered) {
    return json({ error: "engines_failed", message: "The AI engines didn't respond just now — we have your request and will send your results personally.", detail: result.results.map((r) => ({ engine: r.engine, error: r.error || null })) }, 502);
  }

  try {
    await leads.setJSON(token, { ...lead, citationRuns: (lead.citationRuns || 0) + 1, citation: result });
    if (lead.reportId) {
      const reports = getStore("aeo-reports");
      const rep = await reports.get(lead.reportId, { type: "json" });
      if (rep) await reports.setJSON(lead.reportId, { ...rep, citation: result });
    }
  } catch { /* result still returned */ }

  return json(result);
};

export const config = { path: "/api/aeo-citation-test" };

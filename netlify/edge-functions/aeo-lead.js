// AI Visibility Audit — lead capture — POST /api/aeo-lead
// Stores the lead in Netlify Blobs (store "aeo-leads") and returns a one-time
// token that unlocks a single public AI citation test. The frontend also posts
// the same lead to Netlify Forms ("aeo-lead") for the email notification —
// this endpoint is the source of truth if that email ever fails.
import { getStore } from "@netlify/blobs";
import { validateLead } from "../lib/aeo-core.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (body && body.website) return json({ ok: true, leadToken: null }); // honeypot field filled → bot

  const { lead, errors } = validateLead(body);
  if (errors.length) return json({ error: "Please check: " + errors.join(", ") + ".", fields: errors }, 400);

  const leadToken = crypto.randomUUID().replace(/-/g, "");
  const record = { ...lead, leadToken, createdAt: new Date().toISOString(), citationRuns: 0, source: new URL(request.url).hostname };
  try {
    await getStore("aeo-leads").setJSON(leadToken, record);
  } catch (e) {
    return json({ error: "Couldn't save your request right now. Please try again in a minute." }, 503);
  }
  return json({ ok: true, leadToken });
};

export const config = { path: "/api/aeo-lead" };

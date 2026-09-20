// AI Visibility Audit — Report Retrieval — Netlify Edge Function
// Serves a previously-saved scan (written by aeo-audit.js) back by its short
// id, so a report can be shared as a read-only link: /report.html?id=<id>.
// No cost beyond the Edge Function invocation — this only reads from Blobs,
// never calls any paid API.
import { getStore } from "@netlify/blobs";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return json({ error: "Missing ?id= parameter" }, 400);
  // ids are generated as 10-char hex slices (see aeo-audit.js) — reject
  // anything else outright rather than passing arbitrary input to the store.
  if (!/^[a-f0-9]{6,40}$/i.test(id)) return json({ error: "Invalid report id." }, 400);

  try {
    const store = getStore("aeo-reports");
    const data = await store.get(id, { type: "json" });
    if (!data) return json({ error: "Report not found — it may have been an invalid link, or the report may have expired." }, 404);
    return json(data);
  } catch (e) {
    return json({ error: "Could not retrieve report: " + (e.message || "unknown error") }, 500);
  }
};

export const config = { path: "/api/aeo-report" };

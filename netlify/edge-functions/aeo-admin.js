// AI Visibility Audit — admin pipeline API — POST /api/aeo-admin
// Private. Every request needs the header  x-admin-key: <ADMIN_KEY>.
// Body: { "action": "list" }
//       { "action": "update", "type": "lead"|"prospect", "id": "...", "status": "...", "notes": "..." }
//       { "action": "addProspects", "prospects": [ {url, businessName, email, score, grade, topIssue, reportId}, ... ] }
//       { "action": "delete", "type": "prospect", "id": "..." }
// Reads only from Netlify Blobs; never calls a paid API.
import { getStore } from "@netlify/blobs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const env = (k) => { try { return Netlify.env.get(k) || ""; } catch { return ""; } };

const STATUSES = ["new", "contacted", "replied", "won", "lost"];
const MAX_ITEMS = 500;

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

function prospectKey(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    return u.hostname.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "");
  } catch {
    return "";
  }
}

async function readAll(store, limit = MAX_ITEMS) {
  const { blobs } = await store.list();
  const keys = (blobs || []).map((b) => b.key).slice(0, limit);
  const items = await Promise.all(keys.map(async (k) => ({ key: k, value: await store.get(k, { type: "json" }) })));
  return items.filter((i) => i.value);
}

async function listPipeline() {
  const leadsStore = getStore("aeo-leads");
  const prospectsStore = getStore("aeo-prospects");
  const reports = getStore("aeo-reports");
  const [leads, prospects] = await Promise.all([readAll(leadsStore), readAll(prospectsStore)]);

  const leadRows = await Promise.all(
    leads.map(async ({ key, value: l }) => {
      let score = null, grade = null, topIssue = "";
      if (l.reportId) {
        try {
          const r = await reports.get(l.reportId, { type: "json" });
          if (r && r.score) {
            score = r.score.overall;
            grade = r.score.grade;
            const f = (r.score.findings || []).find((x) => x.severity === "critical" || x.severity === "high");
            topIssue = f ? f.text : "";
          }
        } catch { /* report missing */ }
      }
      const c = l.citation;
      return {
        type: "lead", id: key, createdAt: l.createdAt, status: l.status || "new", notes: l.notes || "",
        name: l.name, email: l.email, phone: l.phone, businessName: l.businessName, url: l.url,
        question: l.question, reportId: l.reportId || "", score, grade, topIssue,
        citation: c ? { mentioning: c.summary.providersMentioning, answered: c.summary.providersAnswered, engines: (c.results || []).map((r) => ({ engine: r.engine, mentioned: !!r.mentioned, ok: r.configured && !r.error })) } : null,
      };
    })
  );
  const prospectRows = prospects.map(({ key, value: p }) => ({ type: "prospect", id: key, status: p.status || "new", notes: p.notes || "", ...p }));
  const rows = leadRows.concat(prospectRows).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { rows, statuses: STATUSES };
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const adminKey = env("ADMIN_KEY");
  if (!adminKey) return json({ error: "ADMIN_KEY is not set on this site." }, 503);
  if (!safeEqual(request.headers.get("x-admin-key"), adminKey)) return json({ error: "Invalid access key." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const action = body && body.action;

  try {
    if (action === "list") return json(await listPipeline());

    if (action === "update") {
      const type = body.type === "prospect" ? "prospect" : body.type === "lead" ? "lead" : "";
      const id = clean(body.id, 120);
      if (!type || !id) return json({ error: "type and id are required." }, 400);
      if (body.status != null && !STATUSES.includes(body.status)) return json({ error: "Invalid status." }, 400);
      const store = getStore(type === "lead" ? "aeo-leads" : "aeo-prospects");
      const cur = await store.get(id, { type: "json" });
      if (!cur) return json({ error: "Not found." }, 404);
      const next = { ...cur, updatedAt: new Date().toISOString() };
      if (body.status != null) next.status = body.status;
      if (body.notes != null) next.notes = clean(body.notes, 2000);
      await store.setJSON(id, next);
      return json({ ok: true, status: next.status || "new", notes: next.notes || "" });
    }

    if (action === "addProspects") {
      const list = Array.isArray(body.prospects) ? body.prospects.slice(0, 50) : [];
      if (!list.length) return json({ error: "No prospects to add." }, 400);
      const store = getStore("aeo-prospects");
      const added = [], updated = [], skipped = [];
      for (const p of list) {
        const id = prospectKey(p && p.url);
        if (!id) { skipped.push(String((p && p.url) || "")); continue; }
        const existing = await store.get(id, { type: "json" });
        const rec = {
          ...(existing || {}),
          url: clean(p.url, 200),
          businessName: clean(p.businessName, 100) || (existing && existing.businessName) || "",
          email: clean(p.email, 120).toLowerCase() || (existing && existing.email) || "",
          score: Number.isFinite(Number(p.score)) ? Number(p.score) : null, grade: clean(p.grade, 2),
          topIssue: clean(p.topIssue, 400),
          reportId: /^[a-f0-9]{6,40}$/i.test(String(p.reportId || "")) ? p.reportId : (existing && existing.reportId) || "",
          createdAt: (existing && existing.createdAt) || new Date().toISOString(),
          status: (existing && existing.status) || "new", notes: (existing && existing.notes) || "",
        };
        await store.setJSON(id, rec);
        (existing ? updated : added).push(id);
      }
      return json({ ok: true, added, updated, skipped });
    }

    if (action === "delete") {
      if (body.type !== "prospect") return json({ error: "Only prospects can be deleted here." }, 400);
      const id = clean(body.id, 120);
      await getStore("aeo-prospects").delete(id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Storage error: " + String((e && e.message) || e).slice(0, 200) }, 500);
  }
};

export const config = { path: "/api/aeo-admin" };

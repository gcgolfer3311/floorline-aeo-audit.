// AI Visibility Audit — scan endpoint (v2) — GET /api/aeo-audit?url=
// Deterministic checks only. No LLM calls, no paid APIs: zero per-request
// cost beyond the Edge Function invocation. All scoring logic lives in
// ../lib/aeo-core.js and is unit-tested in /tests.
//
// Every completed scan is saved to Netlify Blobs under a short id so it can
// be shared as a read-only link (best-effort: a storage failure never breaks
// the scan itself).
import { getStore } from "@netlify/blobs";
import {
  checkAllBots, robotsSitemaps, extractJsonLd, extractContactEmails, typesOf, analyzeContentFormat, analyzeTechnical,
  computeScore, buildFixKit, guessBusinessName, detectEdgeBlock, normalizeOrigin, isPrivateHost,
} from "../lib/aeo-core.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const env = (k) => { try { return Netlify.env.get(k); } catch { return undefined; } };

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { redirect: "follow", ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readText(res, maxChars = 1_500_000) {
  try {
    const t = await res.text();
    return t.length > maxChars ? t.slice(0, maxChars) : t;
  } catch {
    return "";
  }
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const target = new URL(request.url).searchParams.get("url");
  if (!target) return json({ error: "Enter a website address to scan." }, 400);
  const origin = normalizeOrigin(target);
  if (!origin) return json({ error: "That doesn't look like a valid website address." }, 400);
  if (isPrivateHost(origin, env("AEO_ALLOW_LOCAL") === "1")) return json({ error: "That address can't be scanned." }, 400);

  const ua = { "User-Agent": "Mozilla/5.0 (compatible; FloorlineAI-AEOAudit/2.0; +https://floorlineai.com/audit)", Accept: "text/html,application/xhtml+xml,*/*" };
  const gptbotUa = { "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" };

  const [robotsR, llmsR, homeR, botR] = await Promise.allSettled([
    fetchWithTimeout(origin + "/robots.txt", { headers: ua }, 8000),
    fetchWithTimeout(origin + "/llms.txt", { headers: ua }, 6000),
    fetchWithTimeout(origin + "/", { headers: ua }, 10000),
    fetchWithTimeout(origin + "/", { headers: gptbotUa }, 10000),
  ]);

  let robotsTxt = "";
  if (robotsR.status === "fulfilled" && robotsR.value.ok) {
    const ct = robotsR.value.headers.get("content-type") || "";
    const body = await readText(robotsR.value, 200_000);
    // Some hosts return their HTML homepage for a missing robots.txt.
    if (!/text\/html/i.test(ct) && !/<html/i.test(body.slice(0, 500))) robotsTxt = body;
  }

  let llmsTxtPresent = false;
  if (llmsR.status === "fulfilled" && llmsR.value.ok) {
    const ct = llmsR.value.headers.get("content-type") || "";
    llmsTxtPresent = !/text\/html/i.test(ct);
    try { await llmsR.value.body?.cancel(); } catch { /* ignore */ }
  }

  let html = "";
  let headers = {};
  let finalOrigin = origin;
  const normalFetchOk = homeR.status === "fulfilled" && homeR.value.ok;
  if (normalFetchOk) {
    html = await readText(homeR.value);
    homeR.value.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    try { finalOrigin = new URL(homeR.value.url || origin).origin; } catch { /* keep */ }
  }
  const homepageFetchFailed = !normalFetchOk || !html;

  let edgeBlock = { state: "ok", reason: null };
  if (botR.status === "fulfilled") {
    const res = botR.value;
    const botHtml = res.status === 403 ? "" : await readText(res);
    edgeBlock = detectEdgeBlock({ normalFetchOk, status: res.status, botHtml, normalHtmlLength: html.length });
  } else if (!normalFetchOk) {
    edgeBlock = { state: "inconclusive", reason: "Neither the normal nor the AI-bot request succeeded." };
  }

  let sitemapFound = robotsSitemaps(robotsTxt).length > 0;
  if (!sitemapFound && !homepageFetchFailed) {
    try {
      const sm = await fetchWithTimeout(origin + "/sitemap.xml", { headers: ua }, 5000);
      if (sm.ok) sitemapFound = /<(urlset|sitemapindex)\b/i.test((await readText(sm, 50_000)).slice(0, 50_000));
    } catch { /* not found */ }
  }

  const botResults = checkAllBots(robotsTxt);
  const jsonLd = html ? extractJsonLd(html) : { nodes: [], malformed: 0 };
  const jsonLdTypes = typesOf(jsonLd.nodes);
  const contentSignals = html ? analyzeContentFormat(html) : { hasFaqFormat: false, directAnswerLikely: false, faqHeadingCount: 0, firstParaWordCount: 0 };
  const technical = analyzeTechnical({ html, headers, origin: finalOrigin });

  const score = computeScore({ botResults, jsonLd, contentSignals, technical, sitemapFound, llmsTxtPresent, edgeBlock, homepageFetchFailed });
  const businessName = guessBusinessName({ entityName: score.entity.name, ogSiteName: technical.ogSiteName, title: technical.title, origin: finalOrigin });
  const fixKit = homepageFetchFailed ? [] : buildFixKit({ origin: finalOrigin, botResults, technical, entity: score.entity, hasFaqSchema: jsonLdTypes.includes("FAQPage"), businessName });

  const result = {
    version: 2,
    url: finalOrigin,
    businessName,
    robotsTxtFound: !!robotsTxt,
    homepageFetchFailed,
    sitemapFound,
    botResults,
    jsonLdTypes,
    contentSignals,
    technical: {
      noindex: technical.noindex, visibleWords: technical.visibleWords, jsRendered: technical.jsRendered,
      https: technical.https, title: technical.title, metaDescription: technical.metaDescription,
      phoneFound: !!technical.phone, addressVisible: technical.addressVisible,
    },
    llmsTxtPresent,
    contactEmails: html ? extractContactEmails(html) : [],
    edgeBlock,
    score,
    fixKit,
    generatedAt: new Date().toISOString(),
  };

  let reportId = null;
  if (!homepageFetchFailed) {
    try {
      reportId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      await getStore("aeo-reports").setJSON(reportId, result);
    } catch {
      reportId = null;
    }
  }
  return json({ ...result, reportId });
};

export const config = { path: "/api/aeo-audit" };

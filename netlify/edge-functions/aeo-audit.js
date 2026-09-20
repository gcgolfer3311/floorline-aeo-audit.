// AI Visibility / AEO Audit — Netlify Edge Function
// Deterministic checks only: robots.txt bot access, CDN edge-block detection,
// JSON-LD structured data, and content-format heuristics.
// No LLM calls, no external API keys required — this endpoint has zero
// per-request cost beyond the Netlify Edge Function invocation itself.
//
// Every completed scan is also saved to Netlify Blobs under a short id and
// returned as `reportId`, so the frontend can build a shareable, read-only
// link at /report.html?id=<reportId> (served by aeo-report.js). Storage is
// best-effort: if Blobs isn't provisioned or a write fails, the scan itself
// still returns normally, just without a reportId.
import { getStore } from "@netlify/blobs";
//
// ---------------------------------------------------------------------------
// The pure logic below (BOTS through computeScore) is copied verbatim from a
// unit-tested module (18/18 passing: root-level robots.txt parsing incl.
// grouped user-agents, case-insensitivity, Allow-overrides-Disallow, JSON-LD
// incl. @graph, malformed JSON-LD handling, FAQ/direct-answer heuristics,
// full scoring pipeline best/worst case, edge-block score capping, and
// homepage-fetch-failure handling). Only the fetch orchestration below the
// "EDGE FUNCTION HANDLER" line is new and can't be unit-tested outside the
// Netlify/Deno runtime — it's written defensively (timeouts + try/catch on
// every network call) for that reason.
// ---------------------------------------------------------------------------

const BOTS = [
  { token: "GPTBot", company: "OpenAI", role: "Model training", critical: true },
  { token: "OAI-SearchBot", company: "OpenAI", role: "ChatGPT Search citations", critical: true },
  { token: "ChatGPT-User", company: "OpenAI", role: "Live fetch on user request", critical: false },
  { token: "ClaudeBot", company: "Anthropic", role: "Training + retrieval", critical: true },
  { token: "Claude-User", company: "Anthropic", role: "Live fetch on user request", critical: false },
  { token: "Claude-SearchBot", company: "Anthropic", role: "Claude search citations", critical: false },
  { token: "PerplexityBot", company: "Perplexity", role: "Answer citations", critical: true },
  { token: "Perplexity-User", company: "Perplexity", role: "Live fetch on user request", critical: false },
  { token: "Google-Extended", company: "Google", role: "Gemini / AI Overviews", critical: true },
  { token: "GoogleOther", company: "Google", role: "General AI crawling", critical: false },
  { token: "Applebot-Extended", company: "Apple", role: "Apple Intelligence", critical: false },
  { token: "bingbot", company: "Microsoft", role: "Bing index -> Copilot", critical: true },
];

function parseRobotsTxtGroups(text) {
  const lines = String(text || "").split(/\r?\n/);
  const groups = [];
  let current = null;
  let sawRuleSinceLastAgent = false;

  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || sawRuleSinceLastAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRuleSinceLastAgent = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      if (!current) continue;
      current.rules.push({ type: field, path: value });
      sawRuleSinceLastAgent = true;
    }
  }
  return groups;
}

// Root-level accessibility only (not full path-precedence robots.txt evaluation).
function botAccessCheck(groups, botToken) {
  const lower = botToken.toLowerCase();
  let group = groups.find((g) => g.agents.includes(lower));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, reason: "not mentioned (default allow)" };

  const rootDisallow = group.rules.some((r) => r.type === "disallow" && r.path === "/");
  const rootAllow = group.rules.some((r) => r.type === "allow" && (r.path === "/" || r.path === ""));

  if (rootDisallow && !rootAllow) {
    return { allowed: false, reason: `Disallow: / under User-agent: ${group.agents.join(", ")}` };
  }
  return { allowed: true, reason: "no root-level block found" };
}

function checkAllBots(robotsTxt) {
  const groups = parseRobotsTxtGroups(robotsTxt);
  return BOTS.map((b) => ({ ...b, ...botAccessCheck(groups, b.token) }));
}

function extractJsonLdTypes(html) {
  const found = new Set();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      collectTypes(parsed, found);
    } catch {
      // malformed JSON-LD block — skip, don't crash
    }
  }
  return Array.from(found);
}

function collectTypes(node, found) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectTypes(n, found));
    return;
  }
  if (typeof node !== "object") return;
  if (node["@type"]) {
    const t = node["@type"];
    (Array.isArray(t) ? t : [t]).forEach((x) => found.add(String(x)));
  }
  if (node["@graph"]) collectTypes(node["@graph"], found);
}

function analyzeContentFormat(html) {
  const text = String(html || "");

  const headings = [...text.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => stripTags(m[1]));
  const faqHeadingCount = headings.filter((h) => /\?\s*$/.test(h.trim())).length;

  const paragraphs = [...text.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]).trim())
    .filter(Boolean);
  const firstPara = paragraphs[0] || "";
  const wordCount = firstPara.split(/\s+/).filter(Boolean).length;
  const directAnswerLikely = wordCount >= 15 && wordCount <= 60;

  return { faqHeadingCount, hasFaqFormat: faqHeadingCount >= 2, firstParaWordCount: wordCount, directAnswerLikely };
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function computeScore({ botResults, jsonLdTypes, contentSignals, llmsTxtPresent, edgeBlock, homepageFetchFailed }) {
  const findings = [];
  const recommendations = [];
  const edgeState = edgeBlock && edgeBlock.state ? edgeBlock.state : "ok";

  if (homepageFetchFailed) {
    findings.push({
      severity: "critical",
      text: "Could not fetch the homepage at all (even with a normal browser user-agent). Structured data and content checks could not be verified — this itself is a strong negative signal, since if a standard fetch fails, AI crawlers likely fail too.",
    });
  }

  const allowedCount = botResults.filter((b) => b.allowed).length;
  let crawlerScore = Math.round((allowedCount / botResults.length) * 40);
  const blockedCritical = botResults.filter((b) => b.critical && !b.allowed);

  if (edgeState === "blocked") {
    crawlerScore = Math.min(crawlerScore, 10);
    findings.push({
      severity: "critical",
      text: `AI crawlers appear blocked at the CDN/edge layer even though a normal browser request succeeds (${edgeBlock.reason}).`,
    });
    recommendations.push("Check your CDN/host dashboard (Cloudflare especially) for an 'AI Scrapers' or 'AI bots' block toggle and disable it if you want AI visibility.");
  } else if (edgeState === "inconclusive") {
    findings.push({
      severity: "info",
      text: "Could not verify AI-bot access at the CDN/edge layer — a normal request to this site also failed, so an AI-specific block couldn't be isolated from a general automated-traffic block.",
    });
  }
  if (blockedCritical.length) {
    findings.push({
      severity: "high",
      text: `${blockedCritical.length} major AI crawler(s) blocked in robots.txt: ${blockedCritical.map((b) => b.token).join(", ")}.`,
    });
    recommendations.push(`Allow ${blockedCritical.map((b) => b.token).join(", ")} in robots.txt if you want to appear in their answers.`);
  }
  if (allowedCount === botResults.length && edgeState === "ok") {
    findings.push({ severity: "good", text: "All 12 major AI crawlers can access the site." });
  }

  const hasBiz = jsonLdTypes.some((t) => ["LocalBusiness", "Organization"].includes(t) || t.includes("LocalBusiness"));
  const hasFaqSchema = jsonLdTypes.includes("FAQPage");
  const hasReview = jsonLdTypes.some((t) => ["Review", "AggregateRating"].includes(t));
  const structuredScore = (hasBiz ? 15 : 0) + (hasFaqSchema ? 10 : 0) + (hasReview ? 10 : 0);
  if (!hasBiz) recommendations.push("Add LocalBusiness/Organization JSON-LD schema so AI engines can identify who you are, where, and what you do.");
  if (!hasFaqSchema) recommendations.push("Add an FAQPage schema block — this is one of the strongest direct signals AI answer engines use for citation.");
  if (!hasReview) recommendations.push("Add Review/AggregateRating schema if you have real reviews — this feeds trust signals AI engines weigh.");

  const contentScore = (contentSignals.hasFaqFormat ? 12 : 0) + (contentSignals.directAnswerLikely ? 13 : 0);
  if (!contentSignals.hasFaqFormat) recommendations.push("Add a visible FAQ section with real questions as headings — AI engines quote FAQ-formatted content disproportionately.");
  if (!contentSignals.directAnswerLikely) recommendations.push("Open your main page content with a direct 15-40 word answer to 'what is this business / what do you do' before anything else.");

  const overall = Math.min(100, crawlerScore + structuredScore + contentScore);

  return {
    overall,
    subscores: { crawlerAccess: crawlerScore, structuredData: structuredScore, contentFormat: contentScore },
    llmsTxt: {
      present: llmsTxtPresent,
      note: "Informational only — 2026 studies (Ahrefs, SE Ranking, Trakkr) found no measurable citation impact. Nice-to-have, not a priority.",
    },
    findings,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// EDGE FUNCTION HANDLER — fetch orchestration
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

function normalizeOrigin(input) {
  let u = String(input || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

// Deliberately conservative: a bare keyword like "captcha" appears on plenty
// of legitimate full pages (login flows, bundled JS) — an earlier version of
// this check false-positived against a real site (github.com) in testing.
// Only flag a block on an explicit block-status code, a full-phrase
// challenge marker, or the bot-UA response being drastically smaller than
// the real page. Unit-tested against both the false-positive regression and
// true-positive cases (18/18 + 5 additional edge-block tests, 23/23 total).
function detectEdgeBlock({ normalFetchOk, status, botHtml, normalHtmlLength }) {
  // If the plain fetch also failed, we have no working baseline — a site
  // that blocks everything indiscriminately isn't evidence of an
  // AI-bot-specific block. Found via live test: npmjs.com returned 403 to
  // both a normal UA and a GPTBot UA (broad WAF, not AI-specific).
  if (!normalFetchOk) {
    return {
      state: "inconclusive",
      reason: "Could not establish a baseline — the normal-UA fetch also failed, so an AI-bot-specific block can't be isolated from a general automated-traffic block.",
    };
  }
  if (status === 403 || status === 503) {
    return { state: "blocked", reason: `HTTP ${status} returned to AI-bot user-agent (a normal-UA fetch to the same URL succeeded)` };
  }
  if (typeof botHtml === "string" && botHtml.length) {
    const lower = botHtml.toLowerCase();
    const strongMarkers = [
      "checking your browser before accessing",
      "attention required! | cloudflare",
      "please enable cookies",
      "cf-browser-verification",
      "ddos protection by cloudflare",
      "just a moment...",
    ];
    const matched = strongMarkers.find((m) => lower.includes(m));
    if (matched) {
      return { state: "blocked", reason: `Challenge-page marker found in bot-UA response: "${matched}"` };
    }
    if (normalHtmlLength > 2000 && botHtml.length < normalHtmlLength * 0.15) {
      return {
        state: "blocked",
        reason: `Bot-UA response was ${botHtml.length} chars vs ${normalHtmlLength} chars on a normal fetch — likely served a stub/challenge page instead of the real page`,
      };
    }
  }
  return { state: "ok", reason: null };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    return json({ error: "Missing ?url= parameter" }, 400);
  }

  const origin = normalizeOrigin(target);
  if (!origin) {
    return json({ error: "That doesn't look like a valid URL." }, 400);
  }

  const ua = { "User-Agent": "Mozilla/5.0 (compatible; FloorlineAI-AEOAudit/1.0; +https://floorlineai.com)" };
  const gptbotUa = { "User-Agent": "GPTBot/1.0 (+https://openai.com/gptbot)" };

  const [robotsResult, llmsResult, homepageResult, botUaResult] = await Promise.allSettled([
    fetchWithTimeout(origin + "/robots.txt", { headers: ua }, 8000),
    fetchWithTimeout(origin + "/llms.txt", { method: "HEAD", headers: ua }, 6000),
    fetchWithTimeout(origin + "/", { headers: ua }, 9000),
    fetchWithTimeout(origin + "/", { headers: gptbotUa }, 9000),
  ]);

  let robotsTxt = "";
  if (robotsResult.status === "fulfilled" && robotsResult.value.ok) {
    try { robotsTxt = await robotsResult.value.text(); } catch { robotsTxt = ""; }
  }

  let llmsTxtPresent = false;
  if (llmsResult.status === "fulfilled") {
    llmsTxtPresent = llmsResult.value.ok;
  }

  let html = "";
  let homepageFetchFailed = false;
  if (homepageResult.status === "fulfilled" && homepageResult.value.ok) {
    try { html = await homepageResult.value.text(); } catch { homepageFetchFailed = true; }
  } else {
    homepageFetchFailed = true;
  }

  const normalFetchOk = homepageResult.status === "fulfilled" && homepageResult.value.ok;
  let edgeBlock = { state: "ok", reason: null };
  if (botUaResult.status === "fulfilled") {
    const res = botUaResult.value;
    let botHtml = "";
    try {
      botHtml = res.ok || res.status !== 403 ? await res.text() : "";
    } catch {
      botHtml = "";
    }
    edgeBlock = detectEdgeBlock({ normalFetchOk, status: res.status, botHtml, normalHtmlLength: html.length });
  } else if (!normalFetchOk) {
    edgeBlock = { state: "inconclusive", reason: "Neither the normal nor the bot-UA fetch succeeded." };
  }
  // Note: a transient network error on the bot-UA fetch alone (normal fetch
  // still fulfilled) leaves edgeBlock at its "ok" default — only
  // detectEdgeBlock's explicit signals, or a shared failure on both fetches
  // (-> "inconclusive"), change that.

  const botResults = checkAllBots(robotsTxt);
  const jsonLdTypes = html ? extractJsonLdTypes(html) : [];
  const contentSignals = html
    ? analyzeContentFormat(html)
    : { hasFaqFormat: false, directAnswerLikely: false, faqHeadingCount: 0, firstParaWordCount: 0 };

  const score = computeScore({
    botResults,
    jsonLdTypes,
    contentSignals,
    llmsTxtPresent,
    edgeBlock,
    homepageFetchFailed,
  });

  const result = {
    url: origin,
    robotsTxtFound: !!robotsTxt,
    homepageFetchFailed,
    botResults,
    jsonLdTypes,
    contentSignals,
    llmsTxtPresent,
    edgeBlock,
    score,
    generatedAt: new Date().toISOString(),
  };

  let reportId = null;
  try {
    reportId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const store = getStore("aeo-reports");
    await store.setJSON(reportId, result);
  } catch {
    // Storage is best-effort. A Blobs failure (not provisioned, transient
    // error) should never break the scan itself — just no shareable link.
    reportId = null;
  }

  return json({ ...result, reportId });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export const config = { path: "/api/aeo-audit" };

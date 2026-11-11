// Floorline AI — AI Visibility Audit core logic (v2)
// Pure, dependency-free functions shared by the edge functions and the unit
// tests in /tests. Nothing in this file touches the network directly except
// the citation providers, which take an injected `fetchImpl` so they can be
// tested with mocked responses.

export const SCORE_MAX = { crawlerAccess: 30, technical: 20, structuredData: 30, content: 20 };

export const BOTS = [
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

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
export function parseRobotsTxtGroups(text) {
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

export function robotsSitemaps(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.split("#")[0].trim())
    .filter((l) => /^sitemap\s*:/i.test(l))
    .map((l) => l.replace(/^sitemap\s*:/i, "").trim())
    .filter(Boolean);
}

// Root-level accessibility only (not full path-precedence evaluation).
export function botAccessCheck(groups, botToken) {
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

export function checkAllBots(robotsTxt) {
  const groups = parseRobotsTxtGroups(robotsTxt);
  return BOTS.map((b) => ({ ...b, ...botAccessCheck(groups, b.token) }));
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
export function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function metaContent(html, attr, value) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*>`, "i");
  const tag = (String(html || "").match(re) || [])[0];
  if (!tag) return "";
  const c = tag.match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : "";
}

export function visibleText(html) {
  return stripTags(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<template[\s\S]*?<\/template>/gi, " ")
  );
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------
export function extractJsonLd(html) {
  const nodes = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let malformed = 0;
  while ((m = re.exec(String(html || "")))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      flatten(JSON.parse(raw), nodes);
    } catch {
      malformed++;
    }
  }
  return { nodes, malformed };
}

function flatten(node, out) {
  if (!node) return;
  if (Array.isArray(node)) return node.forEach((n) => flatten(n, out));
  if (typeof node !== "object") return;
  if (node["@type"]) out.push(node);
  if (node["@graph"]) flatten(node["@graph"], out);
}

export function typesOf(nodes) {
  const found = new Set();
  nodes.forEach((n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).forEach((t) => found.add(String(t))));
  return Array.from(found);
}

// Backwards-compatible export used by v1 callers/tests.
export function extractJsonLdTypes(html) {
  return typesOf(extractJsonLd(html).nodes);
}

const BIZ_TYPE_RE = /(LocalBusiness|Organization|Restaurant|Store|Dentist|Physician|LegalService|HomeAndConstructionBusiness|AutomotiveBusiness|HealthAndBeautyBusiness|ProfessionalService|MedicalBusiness|FoodEstablishment|LodgingBusiness|Plumber|Electrician|HVACBusiness|RoofingContractor|RealEstateAgent|AccountingService|InsuranceAgency|Corporation)$/;

export function analyzeEntity(nodes) {
  const biz = nodes.find((n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).some((t) => BIZ_TYPE_RE.test(String(t))));
  if (!biz) return { hasBusiness: false, complete: false, missing: ["name", "address", "telephone", "url"] };
  const addr = biz.address;
  const hasAddress = !!(addr && (typeof addr === "string" ? addr.trim() : addr.streetAddress || addr.addressLocality));
  const fields = { name: !!biz.name, address: hasAddress, telephone: !!biz.telephone, url: !!(biz.url || biz["@id"]) };
  const missing = Object.keys(fields).filter((k) => !fields[k]);
  return { hasBusiness: true, complete: missing.length === 0, missing, name: biz.name || "" };
}

// ---------------------------------------------------------------------------
// Content + technical signals
// ---------------------------------------------------------------------------
export function analyzeContentFormat(html) {
  const text = String(html || "");
  const headings = [...text.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => stripTags(m[1]));
  const faqHeadingCount = headings.filter((h) => /\?\s*$/.test(h.trim())).length;
  // <details><summary>Question?</summary> is a very common FAQ pattern too.
  const summaryQs = [...text.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/gi)].filter((m) => /\?\s*$/.test(stripTags(m[1]))).length;
  const paragraphs = [...text.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1]).trim()).filter(Boolean);
  const firstSubstantial = paragraphs.find((p) => p.split(/\s+/).length >= 8) || paragraphs[0] || "";
  const wordCount = firstSubstantial.split(/\s+/).filter(Boolean).length;
  const directAnswerLikely = wordCount >= 15 && wordCount <= 60;
  const qCount = faqHeadingCount + summaryQs;
  return { faqHeadingCount: qCount, hasFaqFormat: qCount >= 2, firstParaWordCount: wordCount, directAnswerLikely };
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const ADDRESS_RE = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.' ]{2,40}\s(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Parkway|Hwy|Highway|Pl|Place|Cir|Circle|Trl|Trail)\b\.?/i;

export function analyzeTechnical({ html, headers, origin }) {
  const h = String(html || "");
  const xRobots = String((headers && (headers["x-robots-tag"] || headers["X-Robots-Tag"])) || "");
  const metaRobots = metaContent(h, "name", "robots");
  const noindex = /noindex/i.test(metaRobots) || /noindex/i.test(xRobots);
  const text = visibleText(h);
  const words = text ? text.split(/\s+/).length : 0;
  const scriptCount = (h.match(/<script\b/gi) || []).length;
  const emptyAppRoot = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(h);
  const jsRendered = words < 80 && (emptyAppRoot || scriptCount >= 3);
  const titleMatch = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : "";
  const metaDescription = metaContent(h, "name", "description");
  const ogSiteName = metaContent(h, "property", "og:site_name");
  const canonical = (h.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) || [""])[0];
  const phoneMatch = text.match(PHONE_RE);
  const telLink = h.match(/href=["']tel:([^"']+)["']/i);
  const addressVisible = ADDRESS_RE.test(text);
  return {
    noindex,
    noindexSource: noindex ? (/noindex/i.test(xRobots) ? "X-Robots-Tag header" : "meta robots tag") : null,
    visibleWords: words,
    scriptCount,
    jsRendered,
    thinContent: !jsRendered && words < 150,
    https: /^https:/i.test(String(origin || "")),
    title,
    metaDescription,
    hasCanonical: !!canonical,
    ogSiteName,
    phone: telLink ? decodeEntities(telLink[1]).trim() : phoneMatch ? phoneMatch[0].trim() : "",
    addressVisible,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
export function computeScore({ botResults, jsonLd, contentSignals, technical, sitemapFound, llmsTxtPresent, edgeBlock, homepageFetchFailed }) {
  const findings = [];
  const recommendations = [];
  const rec = (impact, text) => recommendations.push({ impact, text });
  const edgeState = edgeBlock && edgeBlock.state ? edgeBlock.state : "ok";
  const nodes = (jsonLd && jsonLd.nodes) || [];
  const types = typesOf(nodes);
  const t = technical || {};

  if (homepageFetchFailed) {
    findings.push({ severity: "critical", text: "Could not fetch the homepage at all, even with a normal browser user-agent. If a standard request fails, AI crawlers almost certainly fail too." });
  }

  // --- Crawler access (30)
  const allowedCount = botResults.filter((b) => b.allowed).length;
  let crawlerAccess = Math.round((allowedCount / botResults.length) * SCORE_MAX.crawlerAccess);
  const blockedCritical = botResults.filter((b) => b.critical && !b.allowed);
  if (edgeState === "blocked") {
    crawlerAccess = Math.min(crawlerAccess, 8);
    findings.push({ severity: "critical", text: `AI crawlers appear blocked at the CDN/firewall layer even though a normal browser request succeeds (${edgeBlock.reason}).` });
    rec("high", "Turn off the 'Block AI bots / AI Scrapers' setting in your CDN or host (Cloudflare: Security → Bots). It overrides robots.txt.");
  } else if (edgeState === "inconclusive") {
    findings.push({ severity: "info", text: "Couldn't isolate an AI-bot-specific firewall block, because a normal request to this site also failed." });
  }
  if (blockedCritical.length) {
    findings.push({ severity: "high", text: `${blockedCritical.length} major AI crawler(s) blocked in robots.txt: ${blockedCritical.map((b) => b.token).join(", ")}.` });
    rec("high", `Allow ${blockedCritical.map((b) => b.token).join(", ")} in robots.txt (copy-paste fix below).`);
  }
  if (allowedCount === botResults.length && edgeState === "ok" && !homepageFetchFailed) {
    findings.push({ severity: "good", text: `All ${botResults.length} major AI crawlers are allowed in.` });
  }

  // --- Technical readability (20)
  let technicalScore = 0;
  if (!homepageFetchFailed) {
    if (!t.noindex) technicalScore += 8;
    else {
      findings.push({ severity: "critical", text: `Your homepage tells search and AI engines NOT to index it (noindex via ${t.noindexSource}). Nothing else on this report matters until that's removed.` });
      rec("high", "Remove the noindex directive from your homepage (meta robots tag or X-Robots-Tag header).");
    }
    if (t.jsRendered) {
      findings.push({ severity: "critical", text: `Only ${t.visibleWords} words of readable text in the raw HTML — the page is built by JavaScript. Most AI crawlers don't run JavaScript, so to them your site is nearly blank.` });
      rec("high", "Serve real text in the HTML (server-side rendering, pre-rendering, or a static build). AI crawlers read the raw HTML, not what the browser builds.");
    } else if (t.thinContent) {
      technicalScore += 3;
      findings.push({ severity: "high", text: `Thin homepage: only ${t.visibleWords} words of readable text. AI engines need enough text to understand and quote what you do.` });
      rec("medium", "Add at least 300 words of plain, specific copy: what you do, who you serve, where, and how it works.");
    } else technicalScore += 6;
    if (sitemapFound) technicalScore += 3;
    else rec("low", "Publish a sitemap.xml and reference it in robots.txt so crawlers find every page.");
    if (t.https) technicalScore += 3;
    else {
      findings.push({ severity: "high", text: "Site isn't served over HTTPS." });
      rec("high", "Serve the site over HTTPS.");
    }
  }

  // --- Structured data (30)
  const entity = analyzeEntity(nodes);
  const hasFaqSchema = types.includes("FAQPage");
  const hasReview = types.some((x) => ["Review", "AggregateRating"].includes(x)) || nodes.some((n) => n.aggregateRating || n.review);
  let structuredData = (entity.hasBusiness ? 12 : 0) + (entity.complete ? 5 : 0) + (hasFaqSchema ? 8 : 0) + (hasReview ? 5 : 0);
  if (!entity.hasBusiness) {
    findings.push({ severity: "high", text: "No business identity schema (LocalBusiness/Organization). AI engines have to guess who you are, where you are, and what you do." });
    rec("high", "Add LocalBusiness JSON-LD with name, address, phone, hours, and service area (template below).");
  } else if (!entity.complete) {
    rec("medium", `Your business schema is missing: ${entity.missing.join(", ")}. Fill those in so AI answers can state them correctly.`);
  } else {
    findings.push({ severity: "good", text: "Complete business identity schema found." });
  }
  if (jsonLd && jsonLd.malformed) {
    findings.push({ severity: "high", text: `${jsonLd.malformed} structured-data block(s) contain invalid JSON and are ignored by every engine.` });
    rec("high", "Fix the invalid JSON-LD block(s) — validate with Google's Rich Results Test.");
  }
  if (!hasFaqSchema) rec("medium", "Add FAQPage schema matching a visible FAQ section (template below).");
  if (!hasReview) rec("low", "If you show real customer reviews on the site, mark them up with Review/AggregateRating schema.");

  // --- Content & entity clarity (20)
  const c = contentSignals || {};
  let content = (c.hasFaqFormat ? 6 : 0) + (c.directAnswerLikely ? 6 : 0);
  if (t.title && t.metaDescription) content += 4;
  else rec("medium", `Add a ${!t.title ? "page title" : "meta description"} that says exactly what you do and where.`);
  if (t.phone || t.addressVisible) content += 4;
  else rec("medium", "Show your phone number and address as plain text on the homepage — AI engines match businesses by name, address, and phone.");
  if (!c.hasFaqFormat) rec("medium", "Add a visible FAQ section with real customer questions as headings. AI engines quote Q&A content heavily.");
  if (!c.directAnswerLikely) rec("medium", "Open the page with a 15–40 word plain answer: what you do, for whom, and where.");

  if (homepageFetchFailed) { structuredData = 0; content = 0; }

  let overall = crawlerAccess + technicalScore + structuredData + content;
  if (t.noindex) overall = Math.min(overall, 20);
  overall = Math.max(0, Math.min(100, overall));

  const order = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => order[a.impact] - order[b.impact]);

  return {
    overall,
    grade: overall >= 85 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : overall >= 40 ? "D" : "F",
    subscores: { crawlerAccess, technical: technicalScore, structuredData, content },
    max: SCORE_MAX,
    llmsTxt: { present: !!llmsTxtPresent, note: "Informational only — no major AI engine has confirmed using llms.txt. Not scored." },
    findings,
    recommendations,
    entity,
  };
}

// ---------------------------------------------------------------------------
// Copy-paste fix kit
// ---------------------------------------------------------------------------
export function guessBusinessName({ entityName, ogSiteName, title, origin }) {
  if (entityName) return entityName;
  if (ogSiteName) return ogSiteName;
  if (title) {
    const part = title.split(/\s[|\-–—:•]\s/)[0].trim();
    if (part && part.length <= 60) return part;
  }
  try { return new URL(origin).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function buildFixKit({ origin, botResults, technical, entity, hasFaqSchema, businessName }) {
  const kit = [];
  const blocked = (botResults || []).filter((b) => !b.allowed);
  if (blocked.length) {
    kit.push({
      id: "robots",
      title: "robots.txt — let AI crawlers in",
      where: "Add to the TOP of /robots.txt (above any 'User-agent: *' block).",
      lang: "text",
      code: blocked.map((b) => `User-agent: ${b.token}\nAllow: /`).join("\n\n") + "\n",
    });
  }
  if (!entity || !entity.hasBusiness || !entity.complete) {
    const schema = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: businessName || "YOUR BUSINESS NAME",
      url: origin,
      telephone: (technical && technical.phone) || "+1-000-000-0000",
      address: { "@type": "PostalAddress", streetAddress: "123 Main St", addressLocality: "City", addressRegion: "AZ", postalCode: "00000", addressCountry: "US" },
      areaServed: "CITY / REGION YOU SERVE",
      description: (technical && technical.metaDescription) || "One or two plain sentences: what you do, for whom, and where.",
      openingHours: "Mo-Fr 09:00-17:00",
      sameAs: ["https://www.google.com/maps?cid=YOUR_GBP_ID", "https://www.facebook.com/yourpage"],
    };
    kit.push({
      id: "localbusiness",
      title: "LocalBusiness schema — tell AI who you are",
      where: "Paste inside <head> on your homepage. Replace every placeholder; change @type to your specific type if one fits (e.g. Plumber, Restaurant, Dentist).",
      lang: "html",
      code: `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>\n`,
    });
  }
  if (!hasFaqSchema) {
    const faq = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "What does " + (businessName || "your business") + " do?", acceptedAnswer: { "@type": "Answer", text: "Answer in 1–3 plain sentences." } },
        { "@type": "Question", name: "What areas do you serve?", acceptedAnswer: { "@type": "Answer", text: "List the cities/neighborhoods you serve." } },
        { "@type": "Question", name: "How much does it cost?", acceptedAnswer: { "@type": "Answer", text: "Give a real price range or how pricing works." } },
      ],
    };
    kit.push({
      id: "faq",
      title: "FAQPage schema — get quoted in AI answers",
      where: "Paste inside <head>. The same questions and answers must also appear as visible text on the page.",
      lang: "html",
      code: `<script type="application/ld+json">\n${JSON.stringify(faq, null, 2)}\n</script>\n`,
    });
  }
  return kit;
}

// ---------------------------------------------------------------------------
// Edge-block detection (unchanged logic from v1)
// ---------------------------------------------------------------------------
export function detectEdgeBlock({ normalFetchOk, status, botHtml, normalHtmlLength }) {
  if (!normalFetchOk) {
    return { state: "inconclusive", reason: "Could not establish a baseline — the normal-UA fetch also failed." };
  }
  if (status === 403 || status === 503) {
    return { state: "blocked", reason: `HTTP ${status} returned to an AI-bot user-agent while a normal request succeeded` };
  }
  if (typeof botHtml === "string" && botHtml.length) {
    const lower = botHtml.toLowerCase();
    const strongMarkers = ["checking your browser before accessing", "attention required! | cloudflare", "please enable cookies", "cf-browser-verification", "ddos protection by cloudflare", "just a moment..."];
    const matched = strongMarkers.find((m) => lower.includes(m));
    if (matched) return { state: "blocked", reason: `challenge page served to AI-bot user-agent ("${matched}")` };
    if (normalHtmlLength > 2000 && botHtml.length < normalHtmlLength * 0.15) {
      return { state: "blocked", reason: `AI-bot user-agent got ${botHtml.length} chars vs ${normalHtmlLength} for a normal request — likely a stub/challenge page` };
    }
  }
  return { state: "ok", reason: null };
}

export function normalizeOrigin(input) {
  let u = String(input || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// Block scans of private/internal hosts (SSRF guard). `allowLocal` is only
// set by the local test harness.
export function isPrivateHost(origin, allowLocal = false) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return true; }
  if (allowLocal) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (/^\[?::1\]?$/.test(host) || host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Citation test — mention detection + provider adapters
// ---------------------------------------------------------------------------
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(llc|inc|co|corp|company|ltd|pllc|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bareDomain(d) {
  return String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

export function detectMention({ text, citations, businessName, domain }) {
  const answer = String(text || "");
  const nAnswer = " " + normName(answer) + " ";
  const nName = normName(businessName);
  const dom = bareDomain(domain);
  const nameHit = nName.length >= 3 && nAnswer.includes(" " + nName + " ");
  const domainInText = !!dom && answer.toLowerCase().includes(dom);
  const urls = (citations || []).map((c) => (c && typeof c === "object" ? `${c.url || ""} ${c.title || ""}` : String(c || "")).toLowerCase());
  const citedWithLink = !!dom && urls.some((u) => u.includes(dom));
  const mentioned = nameHit || domainInText || citedWithLink;
  let snippet = "";
  if (mentioned) {
    const sentences = answer.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
    const hit = sentences.find((s) => (" " + normName(s) + " ").includes(" " + nName + " ") || (dom && s.toLowerCase().includes(dom)));
    snippet = (hit || sentences[0] || "").slice(0, 320);
  } else {
    snippet = answer.replace(/\s+/g, " ").trim().slice(0, 320);
  }
  return { mentioned, citedWithLink, snippet };
}

async function withTimeout(fetchImpl, url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(fetchImpl, url, headers, body, ms) {
  const res = await withTimeout(fetchImpl, url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, ms);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.error && (data.error.message || data.error) || data.message)) || `HTTP ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

export const PROVIDERS = [
  {
    engine: "ChatGPT",
    keyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-5-mini",
    async ask({ fetchImpl, key, model, question, timeoutMs }) {
      const call = (tools) => postJson(fetchImpl, "https://api.openai.com/v1/responses", { Authorization: `Bearer ${key}` }, { model, input: question, ...(tools ? { tools } : {}) }, timeoutMs);
      let data;
      try { data = await call([{ type: "web_search" }]); } catch (e) { if (e.status !== 400) throw e; data = await call(null); }
      let text = typeof data.output_text === "string" ? data.output_text : "";
      const citations = [];
      (data.output || []).forEach((item) => {
        (item.content || []).forEach((c) => {
          if (c.type === "output_text") {
            if (!data.output_text) text += (text ? "\n" : "") + (c.text || "");
            (c.annotations || []).forEach((a) => a.url && citations.push({ url: a.url, title: a.title || "" }));
          }
        });
      });
      return { text, citations };
    },
  },
  {
    engine: "Claude",
    keyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-haiku-5-5",
    async ask({ fetchImpl, key, model, question, timeoutMs }) {
      const call = (tools) => postJson(fetchImpl, "https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model, max_tokens: 1024, messages: [{ role: "user", content: question }], ...(tools ? { tools } : {}) }, timeoutMs);
      let data;
      try { data = await call([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]); } catch (e) { if (e.status !== 400) throw e; data = await call(null); }
      let text = "";
      const citations = [];
      (data.content || []).forEach((b) => {
        if (b.type === "text") {
          text += b.text || "";
          (b.citations || []).forEach((c) => c.url && citations.push({ url: c.url, title: c.title || "" }));
        }
      });
      return { text, citations };
    },
  },
  {
    engine: "Perplexity",
    keyEnv: "PERPLEXITY_API_KEY",
    modelEnv: "PERPLEXITY_MODEL",
    defaultModel: "sonar",
    async ask({ fetchImpl, key, model, question, timeoutMs }) {
      const data = await postJson(fetchImpl, "https://api.perplexity.ai/chat/completions", { Authorization: `Bearer ${key}` }, { model, messages: [{ role: "user", content: question }] }, timeoutMs);
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
      const citations = [];
      (data.search_results || []).forEach((r) => r.url && citations.push({ url: r.url, title: r.title || "" }));
      if (!citations.length) (data.citations || []).forEach((u) => citations.push({ url: String(u), title: "" }));
      return { text, citations };
    },
  },
  {
    engine: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-flash-latest",
    async ask({ fetchImpl, key, model, question, timeoutMs }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const call = (tools) => postJson(fetchImpl, url, { "x-goog-api-key": key }, { contents: [{ role: "user", parts: [{ text: question }] }], ...(tools ? { tools } : {}) }, timeoutMs);
      let data;
      try { data = await call([{ google_search: {} }]); } catch (e) { if (e.status !== 400) throw e; data = await call(null); }
      const cand = (data.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
      const citations = (((cand.groundingMetadata || {}).groundingChunks) || []).filter((g) => g.web).map((g) => ({ url: g.web.uri || "", title: g.web.title || "" }));
      return { text, citations };
    },
  },
];

export async function runCitationTest({ question, businessName, domain, getEnv, fetchImpl, timeoutMs = 27000 }) {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => {
      const key = getEnv(p.keyEnv);
      if (!key) return { engine: p.engine, configured: false, mentioned: false };
      const model = getEnv(p.modelEnv) || p.defaultModel;
      try {
        const { text, citations } = await p.ask({ fetchImpl, key, model, question, timeoutMs });
        if (!text) return { engine: p.engine, configured: true, error: "Empty answer from engine.", mentioned: false };
        const m = detectMention({ text, citations, businessName, domain });
        return { engine: p.engine, configured: true, model, mentioned: m.mentioned, citedWithLink: m.citedWithLink, snippet: m.snippet, citations: citations.slice(0, 6) };
      } catch (e) {
        const msg = e && e.name === "AbortError" ? "Timed out waiting for this engine." : String((e && e.message) || "Request failed").slice(0, 200);
        return { engine: p.engine, configured: true, error: msg, mentioned: false };
      }
    })
  );
  const ok = results.filter((r) => r.configured && !r.error);
  const mentioning = ok.filter((r) => r.mentioned).length;
  return {
    question,
    businessName,
    domain: bareDomain(domain),
    results,
    summary: {
      providersConfigured: results.filter((r) => r.configured).length,
      providersAnswered: ok.length,
      providersMentioning: mentioning,
      citationRate: ok.length ? Math.round((mentioning / ok.length) * 100) : 0,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Lead validation
// ---------------------------------------------------------------------------
export function validateLead(body) {
  const b = body || {};
  const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
  const lead = {
    name: clean(b.name, 80),
    email: clean(b.email, 120).toLowerCase(),
    phone: clean(b.phone, 30),
    businessName: clean(b.businessName, 100),
    url: clean(b.url, 200),
    question: clean(b.question, 200),
    reportId: clean(b.reportId, 40),
  };
  const errors = [];
  if (!lead.name) errors.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email)) errors.push("email");
  if (lead.businessName.length < 2) errors.push("businessName");
  if (lead.question.length < 8) errors.push("question");
  if (lead.reportId && !/^[a-f0-9]{6,40}$/i.test(lead.reportId)) errors.push("reportId");
  return { lead, errors };
}

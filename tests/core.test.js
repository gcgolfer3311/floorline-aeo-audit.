import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAllBots, robotsSitemaps, extractJsonLd, extractJsonLdTypes, analyzeEntity, analyzeContentFormat,
  analyzeTechnical, computeScore, buildFixKit, guessBusinessName, detectEdgeBlock, normalizeOrigin,
  isPrivateHost, detectMention, runCitationTest, validateLead, SCORE_MAX,
} from "../netlify/lib/aeo-core.js";

const GOOD_HTML = `<!doctype html><html><head><title>Desert Plumbing | Mesa AZ Plumber</title>
<meta name="description" content="Licensed plumbers serving Mesa, Gilbert and Chandler.">
<link rel="canonical" href="https://desertplumbing.com/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Plumber","name":"Desert Plumbing","url":"https://desertplumbing.com","telephone":"+1-480-555-0100",
  "address":{"@type":"PostalAddress","streetAddress":"100 E Main St","addressLocality":"Mesa"},
  "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.9","reviewCount":"120"}},
 {"@type":"FAQPage","mainEntity":[]}]}</script></head><body>
<h1>Mesa plumbing done right</h1>
<p>Desert Plumbing is a licensed, family-owned plumbing company serving Mesa, Gilbert and Chandler with same-day repairs, water heaters and drain cleaning.</p>
<h2>Do you offer same-day service?</h2><p>Yes.</p><h2>What areas do you serve?</h2><p>East Valley.</p>
<p>Call <a href="tel:480-555-0100">480-555-0100</a> or visit 100 E Main St, Mesa.</p>
<p>${"Real specific words about plumbing services in the East Valley. ".repeat(40)}</p>
</body></html>`;

function fullScan(html, robots = "", opts = {}) {
  const botResults = checkAllBots(robots);
  const jsonLd = extractJsonLd(html);
  return computeScore({
    botResults, jsonLd, contentSignals: analyzeContentFormat(html),
    technical: analyzeTechnical({ html, headers: opts.headers || {}, origin: opts.origin || "https://desertplumbing.com" }),
    sitemapFound: opts.sitemap !== false, llmsTxtPresent: false,
    edgeBlock: opts.edge || { state: "ok" }, homepageFetchFailed: !!opts.failed,
  });
}

test("score maxima add to 100", () => {
  assert.equal(Object.values(SCORE_MAX).reduce((a, b) => a + b, 0), 100);
});

test("robots: default allow, wildcard block, specific allow overrides", () => {
  assert.ok(checkAllBots("").every((b) => b.allowed));
  assert.ok(checkAllBots("User-agent: *\nDisallow: /").every((b) => !b.allowed));
  const r = checkAllBots("User-agent: GPTBot\nAllow: /\n\nUser-agent: *\nDisallow: /");
  assert.equal(r.find((b) => b.token === "GPTBot").allowed, true);
  assert.equal(r.find((b) => b.token === "ClaudeBot").allowed, false);
});

test("robots: grouped user-agents and case-insensitivity", () => {
  const r = checkAllBots("user-agent: gptbot\nUser-Agent: CLAUDEBOT\ndisallow: /\n");
  assert.equal(r.find((b) => b.token === "GPTBot").allowed, false);
  assert.equal(r.find((b) => b.token === "ClaudeBot").allowed, false);
  assert.equal(r.find((b) => b.token === "PerplexityBot").allowed, true);
});

test("robots: sitemap lines", () => {
  assert.deepEqual(robotsSitemaps("User-agent: *\nSitemap: https://x.com/sitemap.xml # main"), ["https://x.com/sitemap.xml"]);
});

test("json-ld: @graph, arrays, malformed blocks counted not thrown", () => {
  const html = `<script type="application/ld+json">{bad json</script><script type="application/ld+json">[{"@type":["Restaurant","LocalBusiness"],"name":"A"}]</script>`;
  const { nodes, malformed } = extractJsonLd(html);
  assert.equal(malformed, 1);
  assert.deepEqual(extractJsonLdTypes(html).sort(), ["LocalBusiness", "Restaurant"]);
  assert.equal(analyzeEntity(nodes).hasBusiness, true);
  assert.deepEqual(analyzeEntity(nodes).missing.sort(), ["address", "telephone", "url"]);
});

test("good site scores high with no criticals", () => {
  const s = fullScan(GOOD_HTML);
  assert.ok(s.overall >= 90, "overall " + s.overall);
  assert.equal(s.findings.filter((f) => f.severity === "critical").length, 0);
  assert.equal(s.subscores.structuredData, 30);
});

test("noindex caps the score at 20 and is critical", () => {
  const html = GOOD_HTML.replace("<head>", '<head><meta name="robots" content="noindex, nofollow">');
  const s = fullScan(html);
  assert.ok(s.overall <= 20);
  assert.ok(s.findings.some((f) => f.severity === "critical" && /noindex/i.test(f.text)));
  const s2 = fullScan(GOOD_HTML, "", { headers: { "x-robots-tag": "noindex" } });
  assert.ok(s2.overall <= 20);
});

test("JS-rendered SPA shell is flagged critical", () => {
  const html = `<html><head><title>App</title></head><body><div id="root"></div><script src="a.js"></script></body></html>`;
  const t = analyzeTechnical({ html, headers: {}, origin: "https://x.com" });
  assert.equal(t.jsRendered, true);
  const s = fullScan(html);
  assert.ok(s.findings.some((f) => f.severity === "critical" && /JavaScript/.test(f.text)));
});

test("blocked robots + edge block lowers crawler score", () => {
  const s = fullScan(GOOD_HTML, "User-agent: *\nDisallow: /", { edge: { state: "blocked", reason: "HTTP 403" } });
  assert.equal(s.subscores.crawlerAccess, 0);
  assert.ok(s.findings.some((f) => f.severity === "critical"));
  assert.equal(s.recommendations[0].impact, "high");
});

test("homepage fetch failure zeroes content scores", () => {
  const s = fullScan("", "", { failed: true, edge: { state: "inconclusive" } });
  assert.equal(s.subscores.structuredData, 0);
  assert.equal(s.subscores.technical, 0);
  assert.ok(s.findings.some((f) => f.severity === "critical"));
});

test("technical: phone via tel link, address, title, https", () => {
  const t = analyzeTechnical({ html: GOOD_HTML, headers: {}, origin: "https://desertplumbing.com" });
  assert.equal(t.phone, "480-555-0100");
  assert.equal(t.addressVisible, true);
  assert.equal(t.title, "Desert Plumbing | Mesa AZ Plumber");
  assert.equal(t.https, true);
  assert.equal(t.noindex, false);
});

test("content: details/summary FAQ pattern counts", () => {
  const c = analyzeContentFormat("<details><summary>Is it free?</summary></details><details><summary>How long?</summary></details>");
  assert.equal(c.hasFaqFormat, true);
});

test("fix kit: robots + schema + faq for a bare site", () => {
  const html = "<html><head><title>Bob's Tacos - Phoenix</title></head><body><p>Tacos.</p></body></html>";
  const botResults = checkAllBots("User-agent: GPTBot\nDisallow: /");
  const entity = analyzeEntity(extractJsonLd(html).nodes);
  const technical = analyzeTechnical({ html, headers: {}, origin: "https://bobstacos.com" });
  const name = guessBusinessName({ title: technical.title, origin: "https://bobstacos.com" });
  assert.equal(name, "Bob's Tacos");
  const kit = buildFixKit({ origin: "https://bobstacos.com", botResults, technical, entity, hasFaqSchema: false, businessName: name });
  assert.deepEqual(kit.map((k) => k.id), ["robots", "localbusiness", "faq"]);
  assert.match(kit[0].code, /User-agent: GPTBot\nAllow: \//);
  const ld = JSON.parse(kit[1].code.replace(/<\/?script[^>]*>/g, ""));
  assert.equal(ld.name, "Bob's Tacos");
  JSON.parse(kit[2].code.replace(/<\/?script[^>]*>/g, ""));
});

test("fix kit empty for a complete site", () => {
  const nodes = extractJsonLd(GOOD_HTML).nodes;
  const kit = buildFixKit({ origin: "https://x.com", botResults: checkAllBots(""), technical: {}, entity: analyzeEntity(nodes), hasFaqSchema: true, businessName: "X" });
  assert.equal(kit.length, 0);
});

test("edge block detection (v1 regression cases)", () => {
  assert.equal(detectEdgeBlock({ normalFetchOk: false, status: 403 }).state, "inconclusive");
  assert.equal(detectEdgeBlock({ normalFetchOk: true, status: 403, botHtml: "" }).state, "blocked");
  assert.equal(detectEdgeBlock({ normalFetchOk: true, status: 200, botHtml: "<title>Just a moment...</title>", normalHtmlLength: 100 }).state, "blocked");
  assert.equal(detectEdgeBlock({ normalFetchOk: true, status: 200, botHtml: "x".repeat(5000) + "captcha", normalHtmlLength: 5200 }).state, "ok");
  assert.equal(detectEdgeBlock({ normalFetchOk: true, status: 200, botHtml: "tiny", normalHtmlLength: 50000 }).state, "blocked");
});

test("normalizeOrigin + SSRF guard", () => {
  assert.equal(normalizeOrigin("example.com/path?x=1"), "https://example.com");
  assert.equal(normalizeOrigin("not a url"), null);
  assert.equal(normalizeOrigin("intranet"), null);
  for (const h of ["http://localhost:8080", "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.1", "http://169.254.169.254", "http://172.20.0.1"]) {
    assert.equal(isPrivateHost(h), true, h);
  }
  assert.equal(isPrivateHost("https://example.com"), false);
  assert.equal(isPrivateHost("http://localhost:8080", true), false);
});

test("mention detection: name variants, domain, citations", () => {
  const base = { businessName: "Aspen Placement, LLC", domain: "https://www.aspenplacement.com/" };
  let m = detectMention({ ...base, text: "Top picks: Aspen Placement and Other Co. Both are great.", citations: [] });
  assert.equal(m.mentioned, true);
  assert.match(m.snippet, /Aspen Placement/);
  m = detectMention({ ...base, text: "See other options.", citations: [{ url: "https://aspenplacement.com/about" }] });
  assert.equal(m.mentioned, true);
  assert.equal(m.citedWithLink, true);
  m = detectMention({ ...base, text: "Try Aspenwood Senior Care or Desert Springs.", citations: [] });
  assert.equal(m.mentioned, false);
  assert.match(m.snippet, /Aspenwood/);
});

test("citation test with mocked engines", async () => {
  const fakeFetch = async (url) => {
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.includes("openai")) return ok({ output: [{ type: "message", content: [{ type: "output_text", text: "Try Bob's Tacos on 7th St.", annotations: [{ type: "url_citation", url: "https://bobstacos.com" }] }] }] });
    if (url.includes("anthropic")) return ok({ content: [{ type: "text", text: "I recommend Taco Town.", citations: [] }] });
    if (url.includes("perplexity")) return { ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) };
    if (url.includes("googleapis")) return ok({ candidates: [{ content: { parts: [{ text: "Bob’s Tacos is popular." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertex/redirect", title: "bobstacos.com" } }] } }] });
    throw new Error("unexpected " + url);
  };
  const env = { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b", PERPLEXITY_API_KEY: "c", GEMINI_API_KEY: "d" };
  const r = await runCitationTest({ question: "best tacos phoenix", businessName: "Bob's Tacos", domain: "bobstacos.com", getEnv: (k) => env[k], fetchImpl: fakeFetch });
  const by = Object.fromEntries(r.results.map((x) => [x.engine, x]));
  assert.equal(by.ChatGPT.mentioned, true);
  assert.equal(by.ChatGPT.citedWithLink, true);
  assert.equal(by.Claude.mentioned, false);
  assert.match(by.Perplexity.error, /bad key/);
  assert.equal(by.Gemini.mentioned, true);
  assert.equal(by.Gemini.citedWithLink, true);
  assert.deepEqual(r.summary, { providersConfigured: 4, providersAnswered: 3, providersMentioning: 2, citationRate: 67 });
});

test("citation test: web-search tool rejected (400) falls back to plain call", async () => {
  let calls = 0;
  const fakeFetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.tools) return { ok: false, status: 400, json: async () => ({ error: { message: "tool not supported" } }) };
    return { ok: true, status: 200, json: async () => ({ output_text: "Bob's Tacos." }) };
  };
  const r = await runCitationTest({ question: "q", businessName: "Bob's Tacos", domain: "", getEnv: (k) => (k === "OPENAI_API_KEY" ? "x" : ""), fetchImpl: fakeFetch });
  assert.equal(calls, 2);
  assert.equal(r.results[0].mentioned, true);
  assert.equal(r.results[1].configured, false);
});

test("lead validation", () => {
  const ok = validateLead({ name: "Mike", email: "Mike@Example.com", businessName: "Floorline", question: "best web designer mesa az", reportId: "abc123abc123" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.lead.email, "mike@example.com");
  const bad = validateLead({ name: "", email: "nope", businessName: "x", question: "hi", reportId: "../etc" });
  assert.deepEqual(bad.errors, ["name", "email", "businessName", "question", "reportId"]);
});

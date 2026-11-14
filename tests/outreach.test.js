import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUrlList, topIssue, draftProspectEmail, draftLeadFollowup, mailtoHref, reportLink, toCSV, domainOf } from "../assets/outreach.js";
import { extractContactEmails } from "../netlify/lib/aeo-core.js";

const SENDER = { name: "Michael Smith", phone: "480-388-1877", address: "PO Box 1, Mesa AZ 85201" };

test("parseUrlList: mixed separators, dedupe by domain, junk dropped, limit", () => {
  const list = parseUrlList("bobstacos.com\nhttps://www.bobstacos.com/menu, desertplumbing.com; not a url\nhello\n(example-hvac.com).");
  assert.deepEqual(list, ["https://bobstacos.com", "https://desertplumbing.com", "https://example-hvac.com"]);
  const many = Array.from({ length: 40 }, (_, i) => `site${i}.com`).join("\n");
  assert.equal(parseUrlList(many).length, 25);
  assert.deepEqual(parseUrlList("http://shop.example.com:8080/x"), ["http://shop.example.com:8080/x"]);
});

test("domainOf + reportLink", () => {
  assert.equal(domainOf("https://www.bob.com/x"), "bob.com");
  assert.equal(reportLink("abc123abc123"), "https://floorlineai.com/audit/?r=abc123abc123");
  assert.equal(reportLink(""), "");
});

test("topIssue priority: noindex > firewall > JS > robots > schema", () => {
  const base = { score: { entity: { hasBusiness: false } }, technical: { visibleWords: 500 }, botResults: [], contentSignals: { hasFaqFormat: true } };
  assert.match(topIssue({ ...base, technical: { noindex: true } }), /noindex/);
  assert.match(topIssue({ ...base, edgeBlock: { state: "blocked" } }), /firewall/);
  assert.match(topIssue({ ...base, technical: { jsRendered: true } }), /JavaScript/);
  const bots = [{ token: "GPTBot", company: "OpenAI", allowed: false, critical: true }, { token: "ClaudeBot", company: "Anthropic", allowed: false, critical: true }];
  assert.match(topIssue({ ...base, botResults: bots }), /GPTBot, ClaudeBot.*OpenAI and Anthropic/);
  assert.match(topIssue(base), /schema/);
  assert.equal(topIssue({ score: { entity: { hasBusiness: true, complete: true }, findings: [] }, technical: { visibleWords: 900 }, contentSignals: { hasFaqFormat: true } }), "");
});

test("prospect email: weak site", () => {
  const scan = { url: "https://bobstacos.com", businessName: "Bob's Tacos", reportId: "abc123abc123", score: { overall: 38, grade: "F", entity: { hasBusiness: false } }, technical: { visibleWords: 400 }, botResults: [] };
  const d = draftProspectEmail({ scan, sender: SENDER });
  assert.equal(d.subject, "Can ChatGPT find Bob's Tacos?");
  assert.match(d.body, /38\/100 \(grade F\)/);
  assert.match(d.body, /The biggest problem: there's no business information/);
  assert.match(d.body, /https:\/\/floorlineai\.com\/audit\/\?r=abc123abc123/);
  assert.match(d.body, /PO Box 1, Mesa AZ 85201/);
  assert.match(d.body, /no thanks/);
});

test("prospect email: strong site uses different angle; no address line when blank", () => {
  const scan = { url: "https://good.com", businessName: "", reportId: "", score: { overall: 91, grade: "A", entity: { hasBusiness: true, complete: true }, findings: [] }, technical: {}, botResults: [] };
  const d = draftProspectEmail({ scan, sender: { name: "M" } });
  assert.match(d.subject, /good\.com — does ChatGPT actually recommend you\?/);
  assert.doesNotMatch(d.body, /full report/);
  assert.doesNotMatch(d.body, /undefined/);
});

test("lead follow-up: citation variants, no opt-out line", () => {
  const lead = { name: "Karl Fellers", businessName: "Aspen Placement", url: "https://aspenplacement.com", question: "best senior placement gilbert", reportId: "abc123abc123", score: 52, topIssue: "No FAQ." };
  const none = draftLeadFollowup({ lead: { ...lead, citation: { answered: 3, engines: [{ engine: "ChatGPT", ok: true, mentioned: false }, { engine: "Claude", ok: true, mentioned: false }] } }, sender: SENDER });
  assert.match(none.body, /^Hi Karl,/);
  assert.match(none.body, /none of the AI engines named Aspen Placement/);
  assert.match(none.body, /52\/100\. The biggest issue: No FAQ\./);
  assert.doesNotMatch(none.body, /no thanks/);
  const some = draftLeadFollowup({ lead: { ...lead, citation: { answered: 2, engines: [{ engine: "ChatGPT", ok: true, mentioned: true }, { engine: "Gemini", ok: true, mentioned: false }, { engine: "Claude", ok: false, mentioned: false }] } }, sender: SENDER });
  assert.match(some.body, /ChatGPT named you, but Gemini didn't/);
  const notRun = draftLeadFollowup({ lead: { ...lead, citation: null, score: null }, sender: SENDER });
  assert.match(notRun.body, /I'll run the live check/);
  assert.doesNotMatch(notRun.body, /null|undefined/);
});

test("mailto encodes subject/body, keeps @", () => {
  const h = mailtoHref("a@b.com", { subject: "Hi & bye", body: "Line 1\nLine 2" });
  assert.equal(h, "mailto:a@b.com?subject=Hi%20%26%20bye&body=Line%201%0ALine%202");
});

test("CSV quoting + formula-injection guard", () => {
  const csv = toCSV([{ a: 'x,"y"', b: "=HYPERLINK(1)", c: null }], [{ label: "A", key: "a" }, { label: "B", key: "b" }, { label: "C", get: (r) => r.c }]);
  assert.equal(csv, 'A,B,C\r\n"x,""y""",\'=HYPERLINK(1),');
});

test("extractContactEmails: mailto first, text second, junk filtered, dedupe", () => {
  const html = `<a href="mailto:Info@BobsTacos.com?subject=hi">Email</a><p>Or write owner@bobstacos.com, info@bobstacos.com</p>
    <img src="logo@2x.png"><script>var x="dev@sentry.io"</script><p>you@example.com</p>`;
  assert.deepEqual(extractContactEmails(html), ["info@bobstacos.com", "owner@bobstacos.com"]);
  assert.deepEqual(extractContactEmails(""), []);
  assert.doesNotThrow(() => extractContactEmails('<a href="mailto:bad%ZZ@x.com">x</a><a href="mailto:%E0%A4%A@x.com">y</a>'));
});

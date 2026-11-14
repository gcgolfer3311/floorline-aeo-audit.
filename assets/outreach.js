// Floorline AI — outreach helpers for admin.html (browser + Node, no deps).
// Unit-tested in /tests/outreach.test.js.

export const PUBLIC_REPORT_BASE = "https://floorlineai.com/audit/";

export function reportLink(reportId, base = PUBLIC_REPORT_BASE) {
  return reportId ? base + "?r=" + encodeURIComponent(reportId) : "";
}

export function domainOf(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "");
  } catch {
    return String(url || "");
  }
}

// One URL per line (commas/spaces also work). Dedupes by domain, max `limit`.
export function parseUrlList(text, limit = 25) {
  const seen = new Set();
  const out = [];
  String(text || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^[(\[<"']+/, "").replace(/[)\]>"'.,]+$/, ""))
    .filter((s) => /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{2,5})?(\/\S*)?$/i.test(s))
    .forEach((s) => {
      const d = domainOf(s).toLowerCase();
      if (!d || seen.has(d) || out.length >= limit) return;
      seen.add(d);
      out.push(/^https?:\/\//i.test(s) ? s : "https://" + s);
    });
  return out;
}

// Short, plain-English version of the most important problem in a scan.
export function topIssue(scan) {
  const s = (scan && scan.score) || {};
  const t = (scan && scan.technical) || {};
  const bots = (scan && scan.botResults) || [];
  const blocked = bots.filter((b) => !b.allowed && b.critical);
  if (t.noindex) return "your homepage is set to 'noindex', which tells search and AI engines not to list it at all";
  if (scan && scan.edgeBlock && scan.edgeBlock.state === "blocked") return "your hosting firewall is blocking AI crawlers, so ChatGPT and others can't read your site";
  if (t.jsRendered) return "your site is built with JavaScript that most AI crawlers can't read, so to them the page is nearly blank";
  if (blocked.length) return `your robots.txt blocks ${blocked.map((b) => b.token).slice(0, 3).join(", ")} — the crawlers behind ${[...new Set(blocked.map((b) => b.company))].slice(0, 3).join(" and ")}'s AI answers`;
  if (s.entity && !s.entity.hasBusiness) return "there's no business information (schema) telling AI engines who you are, where you are, and what you do";
  if (t.visibleWords != null && t.visibleWords < 150) return "the homepage has very little readable text for AI engines to understand and quote";
  if (s.entity && !s.entity.complete) return `your business schema is missing ${s.entity.missing.join(", ")}`;
  if (scan && scan.contentSignals && !scan.contentSignals.hasFaqFormat) return "there's no FAQ-style content, which is what AI answers quote most";
  const f = (s.findings || []).find((x) => x.severity === "critical" || x.severity === "high");
  return f ? f.text : "";
}

function signature(sender) {
  const s = sender || {};
  const lines = [s.name || "Michael Smith", "Floorline AI" + (s.phone ? " · " + s.phone : "")];
  if (s.address) lines.push(s.address);
  lines.push('Not interested? Just reply "no thanks" and I won\'t email again.');
  return lines.join("\n");
}

export function draftProspectEmail({ scan, sender }) {
  const domain = domainOf(scan.url);
  const name = scan.businessName || domain;
  const score = scan.score ? scan.score.overall : null;
  const grade = scan.score ? scan.score.grade : "";
  const link = reportLink(scan.reportId);
  const issue = topIssue(scan);
  const strong = score != null && score >= 75;

  const subject = strong ? `${name} — does ChatGPT actually recommend you?` : `Can ChatGPT find ${name}?`;
  const lines = [`Hi ${name} team,`, ""];
  lines.push(`I ran a free AI visibility check on ${domain}. It shows whether ChatGPT, Google's AI answers and Perplexity can find your business and recommend it when customers ask.`);
  lines.push("");
  if (strong) {
    lines.push(`Good news: you scored ${score}/100 (grade ${grade}), so AI engines can read your site. The next question is whether they actually name you when someone asks for a business like yours — that's what decides who gets the call.`);
  } else {
    lines.push(`Your score: ${score}/100 (grade ${grade}).`);
    if (issue) lines.push(`The biggest problem: ${issue}.`);
  }
  if (link) {
    lines.push("");
    lines.push(`Here's your full report, including copy-paste fixes: ${link}`);
  }
  lines.push("");
  lines.push(strong
    ? "If you want, I can run a live check on what ChatGPT, Claude, Perplexity and Gemini say about you — takes 10 minutes."
    : "Happy to walk you through it in 10 minutes, or fix it for you. No pressure either way.");
  lines.push("");
  lines.push(signature(sender));
  return { subject, body: lines.join("\n") };
}

export function draftLeadFollowup({ lead, sender }) {
  const first = String(lead.name || "").trim().split(/\s+/)[0] || "there";
  const biz = lead.businessName || domainOf(lead.url);
  const link = reportLink(lead.reportId);
  const c = lead.citation;
  const subject = `Your AI visibility results for ${biz}`;
  const lines = [`Hi ${first},`, "", `Thanks for running the AI visibility check on ${biz}.`, ""];
  if (c && c.answered) {
    const named = (c.engines || []).filter((e) => e.ok && e.mentioned).map((e) => e.engine);
    const missed = (c.engines || []).filter((e) => e.ok && !e.mentioned).map((e) => e.engine);
    if (!named.length) lines.push(`When we asked "${lead.question}", none of the AI engines named ${biz}. That's the gap we fix.`);
    else if (missed.length) lines.push(`When we asked "${lead.question}", ${named.join(" and ")} named you, but ${missed.join(" and ")} didn't.`);
    else lines.push(`When we asked "${lead.question}", all ${named.length} AI engines named you — great position to protect.`);
  } else if (lead.question) {
    lines.push(`I'll run the live check on "${lead.question}" myself and send you what ChatGPT, Claude, Perplexity and Gemini say.`);
  }
  if (lead.score != null) {
    lines.push("");
    lines.push(`Your technical score was ${lead.score}/100${lead.topIssue ? ". The biggest issue: " + lead.topIssue.replace(/\.$/, "") : ""}.`);
  }
  if (link) { lines.push(""); lines.push(`Your full report: ${link}`); }
  lines.push("");
  lines.push("Do you have 10 minutes this week? I can walk you through exactly what to fix — or handle it for you.");
  lines.push("");
  const sig = signature(sender).split("\n");
  sig.pop(); // no opt-out line needed: they asked for this
  lines.push(sig.join("\n"));
  return { subject, body: lines.join("\n") };
}

export function mailtoHref(to, { subject, body }) {
  return "mailto:" + encodeURIComponent(to || "").replace(/%40/g, "@") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}

export function toCSV(rows, columns) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // block spreadsheet formula injection
    return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  return [columns.map((c) => cell(c.label)).join(",")].concat(rows.map((r) => columns.map((c) => cell(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","))).join("\r\n");
}

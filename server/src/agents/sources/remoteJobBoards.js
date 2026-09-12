/**
 * Legit, ToS-compliant job sources: public feeds meant to be consumed by
 * software, listing jobs whose posters explicitly invited applications.
 * No login-walled scraping, no bypassing rate limits, no touching pages
 * that ask not to be automated.
 */
import { getConfig } from "../../services/config.js";

// RemoteOK publishes a public JSON feed at /api — first element is metadata, skip it.
export async function remoteOkAdapter() {
  const res = await fetch("https://remoteok.com/api", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  // No artificial cap — the API itself already returns ~100 listings max
  // per call, and a smaller slice here was silently throwing away most of
  // that pool every cycle for no reason.
  return data
    .filter((item) => item && item.id && item.position)
    .map((item) => ({
      source: "REMOTE_BOARD",
      externalUrl: item.url || `https://remoteok.com/remote-jobs/${item.id}`,
      title: item.position,
      description: stripHtml(item.description || item.position),
      budget: item.salary_min ? `${item.salary_min}-${item.salary_max ?? ""}` : null,
      category: guessCategory(item.position, item.tags || []),
      applyEmail: extractEmail(item.description || ""),
    }));
}

// WeWorkRemotely publishes per-category RSS feeds meant for aggregators.
const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-copywriting-jobs.rss",
  "https://weworkremotely.com/categories/remote-customer-support-jobs.rss",
];

export async function weWorkRemotelyAdapter() {
  const results = [];
  for (const feedUrl of WWR_FEEDS) {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
    });
    if (!res.ok) continue;
    const xml = await res.text();
    for (const item of parseRssItems(xml)) {
      results.push({
        source: "REMOTE_BOARD",
        externalUrl: item.link,
        title: item.title,
        description: stripHtml(item.description),
        budget: null,
        category: guessCategory(item.title, [item.description]),
        applyEmail: extractEmail(item.description),
      });
    }
  }
  return results;
}

// Remotive's own API terms explicitly ask callers to poll "max. 4 times a
// day" (roughly every 6 hours) — this throttle enforces that regardless of
// how often the Hunter Agent itself runs, so a faster Hunter interval
// (set for the other sources) never turns into excessive Remotive traffic
// that risks losing access to a free, working source.
const REMOTIVE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastRemotiveFetchAt = 0;

// Remotive runs a public, no-auth JSON API explicitly meant for reuse —
// no signup, no approval process, works today.
export async function remotiveAdapter() {
  if (Date.now() - lastRemotiveFetchAt < REMOTIVE_MIN_INTERVAL_MS) return [];
  lastRemotiveFetchAt = Date.now();

  const res = await fetch("https://remotive.com/api/remote-jobs?limit=40", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const jobs = data?.jobs || [];
  return jobs.map((job) => ({
    source: "REMOTE_BOARD",
    externalUrl: job.url,
    title: job.title,
    description: stripHtml(job.description || job.title),
    budget: job.salary || null,
    category: guessCategory(job.title, [job.category]),
    applyEmail: extractEmail(job.description || ""),
  }));
}

// Arbeitnow also runs a public, no-auth JSON API — same deal, no gatekeeping.
export async function arbeitnowAdapter() {
  const res = await fetch("https://www.arbeitnow.com/api/job-board-api", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const jobs = (data?.data || []).filter((job) => job.remote);
  return jobs.slice(0, 40).map((job) => ({
    source: "REMOTE_BOARD",
    externalUrl: job.url,
    title: job.title,
    description: stripHtml(job.description || job.title),
    budget: null,
    category: guessCategory(job.title, job.tags || []),
    applyEmail: extractEmail(job.description || ""),
  }));
}

// Himalayas publishes a public, no-auth JSON feed explicitly meant for
// external use (it's linked from their own site as "the Himalayas API").
export async function himalayasAdapter() {
  const res = await fetch("https://himalayas.app/jobs/api", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const jobs = data?.jobs || [];
  return jobs.map((job) => ({
    source: "REMOTE_BOARD",
    externalUrl: job.applicationLink || job.guid,
    title: job.title,
    description: stripHtml(job.description || job.excerpt || job.title),
    budget: job.minSalary ? `${job.minSalary}-${job.maxSalary ?? ""} ${job.salaryPeriod ?? ""}`.trim() : null,
    category: guessCategory(job.title, job.categories || []),
    applyEmail: extractEmail(job.description || ""),
  }));
}

// Jobicy runs a public, no-auth JSON API (documented at jobicy.com/api) —
// same no-signup, no-approval deal as the other board APIs here.
export async function jobicyAdapter() {
  const res = await fetch("https://jobicy.com/api/v2/remote-jobs?count=50", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const jobs = data?.jobs || [];
  return jobs.map((job) => ({
    source: "REMOTE_BOARD",
    externalUrl: job.url,
    title: job.jobTitle,
    description: stripHtml(job.jobDescription || job.jobExcerpt || job.jobTitle),
    budget: job.annualSalaryMin ? `${job.annualSalaryMin}-${job.annualSalaryMax ?? ""}` : null,
    category: guessCategory(job.jobTitle, job.jobIndustry || []),
    applyEmail: extractEmail(job.jobDescription || ""),
  }));
}

// Working Nomads exposes a public, no-auth JSON feed at this same URL its
// own site widget/RSS readers use — no signup, no key.
export async function workingNomadsAdapter() {
  const res = await fetch("https://www.workingnomads.com/api/exposed_jobs/", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const jobs = await res.json();
  return (Array.isArray(jobs) ? jobs : []).map((job) => ({
    source: "REMOTE_BOARD",
    externalUrl: job.url,
    title: job.title,
    description: stripHtml(job.description || job.title),
    budget: null,
    category: guessCategory(job.title, [job.category_name, ...(job.tags || [])]),
    applyEmail: extractEmail(job.description || ""),
  }));
}

// Landing.jobs runs a public, no-auth JSON API at this same URL — no
// signup, no key, documented as an open feed on their own site.
export async function landingJobsAdapter() {
  const res = await fetch("https://landing.jobs/api/v1/jobs", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (getConfig("OWNER_EMAIL") || "n/a") + ")" },
  });
  if (!res.ok) return [];
  const jobs = await res.json();
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job.remote)
    .map((job) => ({
      source: "REMOTE_BOARD",
      externalUrl: job.url,
      title: job.title,
      description: stripHtml(`${job.role_description || ""} ${job.main_requirements || ""}`) || job.title,
      budget: job.gross_salary_low ? `${job.gross_salary_low}-${job.gross_salary_high ?? ""} ${job.currency_code ?? ""}`.trim() : null,
      category: guessCategory(job.title, job.tags || []),
      applyEmail: extractEmail(job.role_description || ""),
    }));
}

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
  for (const block of itemBlocks) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const description = block.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim();
    if (title && link) items.push({ title, link, description: description || title });
  }
  return items;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

function extractEmail(text) {
  const match = stripHtml(text).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

// Broad enough to catch genuine near-misses (a "Data Analyst" posting is
// worth a real Feasibility Agent look, not an instant reject) without
// being so broad it stops meaning anything — Hunter Agent now hard-skips
// anything that lands outside content/data, so a job mis-tagged "other"
// here never even reaches the Feasibility Agent. Erring toward "content"/
// "data" costs one extra Claude call on a near-miss; erring toward
// "other" costs the job entirely.
// Real evidence from a live run (2026-09-12): bare substrings with no word
// boundary were matching constantly on unrelated jobs — "analy" matched
// any "Analyst" job title (Drilling Ops Analyst, Compliance Analyst,
// Financial Analyst — full-time employment, nothing to do with our data/
// research service), and "writ" matched any description mentioning "write
// clean code" or "write status updates". Every false match cost a real
// Claude feasibility call before being correctly rejected. Tightened to
// whole-word patterns, and "analy" (analyst/analysis/analytics) dropped
// entirely — it's too generic a fragment of common job titles to trust as
// a data/research signal.
const CONTENT_PATTERN =
  /\bcopywrit(?:e|ing|er)?\b|\bwrit(?:e|es|ing|ten|er|ers)\b|\bcontent\b|\bblog(?:s|ging|ger)?\b|\barticle(?:s)?\b|\beditor(?:ial)?\b|\bediting\b|\bproofread(?:ing)?\b|\btranslat(?:e|ion|or|ing)\b|\bghostwrit(?:ing|er)?\b|\bscreenplay\b|\bnewsletter\b|press release|\bseo\b/;
const DATA_PATTERN = /\bdata\b|\bscrap(?:e|ing)\b|\bresearch(?:er)?\b|\bexcel\b|\bspreadsheet(?:s)?\b|\bsummar(?:y|ize|ies|ising|izing)\b/;
const CODE_PATTERN = /\bdev(?:eloper)?\b|\bcode\b|\bcoding\b|\bengineer(?:ing)?\b|\bprogram(?:mer|ming)?\b|\bsoftware\b/;

function categoryFrom(text) {
  if (CONTENT_PATTERN.test(text)) return "content";
  if (DATA_PATTERN.test(text)) return "data";
  if (CODE_PATTERN.test(text)) return "code";
  return null;
}

/**
 * `title` must be the job's actual posting title — NOT the first element of
 * a tags/category array. An earlier version of this trusted
 * `tagsOrText[0]`, assuming it was always the title; in reality 6 of the 8
 * adapters below pass a tag or category string first (e.g. Remotive passes
 * `job.category`, Arbeitnow/Landing.jobs pass the first tag), so that
 * "title-first" check was silently checking the wrong field almost every
 * time and immediately falling through to the full-text match anyway —
 * which is exactly the noisy path this was meant to avoid. Real evidence
 * (2026-09-12): sales/CRM/appointment-setter postings ("MSD 365 CRM Lead",
 * "Appointment Setter (Remote)", "Director, Sales Compensation") kept
 * reaching Feasibility because their descriptions happened to mention
 * "data" once, and the title-check was never actually running against
 * their real titles.
 */
function guessCategory(title, tagsOrText) {
  const fromTitle = categoryFrom(String(title || "").toLowerCase());
  if (fromTitle) return fromTitle;

  const joined = [title, ...tagsOrText].join(" ").toLowerCase();
  return categoryFrom(joined) || "other";
}

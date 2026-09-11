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
  return data
    .filter((item) => item && item.id && item.position)
    .slice(0, 30)
    .map((item) => ({
      source: "REMOTE_BOARD",
      externalUrl: item.url || `https://remoteok.com/remote-jobs/${item.id}`,
      title: item.position,
      description: stripHtml(item.description || item.position),
      budget: item.salary_min ? `${item.salary_min}-${item.salary_max ?? ""}` : null,
      category: guessCategory(item.tags || []),
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
        category: guessCategory([item.title, item.description]),
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
    category: guessCategory([job.category, job.title]),
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
    category: guessCategory([...(job.tags || []), job.title]),
    applyEmail: extractEmail(job.description || ""),
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
function guessCategory(tagsOrText) {
  const joined = tagsOrText.join(" ").toLowerCase();
  if (/copy|writ|content|blog|article|editor|editing|proofread|translat|ghostwrit|screenplay|newsletter|press release|seo\b/.test(joined))
    return "content";
  if (/\bdata\b|scrape|research|\bexcel\b|analy|spreadsheet|summar/.test(joined)) return "data";
  if (/\bdev(eloper)?\b|code|engineer|program|software/.test(joined)) return "code";
  return "other";
}

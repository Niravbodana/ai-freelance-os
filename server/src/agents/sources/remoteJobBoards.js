/**
 * Legit, ToS-compliant job sources: public feeds meant to be consumed by
 * software, listing jobs whose posters explicitly invited applications.
 * No login-walled scraping, no bypassing rate limits, no touching pages
 * that ask not to be automated.
 */

// RemoteOK publishes a public JSON feed at /api — first element is metadata, skip it.
export async function remoteOkAdapter() {
  const res = await fetch("https://remoteok.com/api", {
    headers: { "User-Agent": "ai-freelance-os (contact: " + (process.env.OWNER_EMAIL || "n/a") + ")" },
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
      headers: { "User-Agent": "ai-freelance-os (contact: " + (process.env.OWNER_EMAIL || "n/a") + ")" },
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

function guessCategory(tagsOrText) {
  const joined = tagsOrText.join(" ").toLowerCase();
  if (/copy|writ|content|blog|article/.test(joined)) return "content";
  if (/data|scrape|research|excel/.test(joined)) return "data";
  if (/dev|code|engineer|program|software/.test(joined)) return "code";
  return "other";
}

import { prisma } from "../db/client.js";
import { encrypt, decrypt } from "./crypto.js";

/**
 * Every credential the app needs, except the four bootstrap env vars
 * (DATABASE_URL, DASHBOARD_USER, DASHBOARD_PASSWORD, ENCRYPTION_KEY — see
 * README/.env.example for why those stay env-only). Everything below is
 * editable from Admin Settings after login, stored encrypted in the
 * Setting table, and falls back to the matching env var if never set
 * there — so a Railway deploy that still sets these as env vars keeps
 * working exactly as before; Admin Settings is additive, not required.
 */
export const SETTINGS_MANIFEST = [
  {
    key: "APP_URL",
    group: "General",
    label: "Public app URL (e.g. https://your-app.up.railway.app)",
    secret: false,
  },
  {
    key: "SYSTEM_PAUSED",
    group: "General",
    label: "Pause all agents (true/false) — the kill switch",
    secret: false,
    placeholder: "false",
  },
  { key: "ANTHROPIC_API_KEY", group: "Claude API", label: "Anthropic API Key", secret: true, testable: true },
  { key: "CLAUDE_MONTHLY_BUDGET_USD", group: "Claude API", label: "Monthly budget (USD, optional)", secret: false },

  { key: "SMTP_HOST", group: "Email (Gmail)", label: "SMTP Host", secret: false, placeholder: "smtp.gmail.com" },
  { key: "SMTP_PORT", group: "Email (Gmail)", label: "SMTP Port", secret: false, placeholder: "587" },
  { key: "SMTP_SECURE", group: "Email (Gmail)", label: "SMTP Secure (true/false)", secret: false, placeholder: "false" },
  { key: "SMTP_USER", group: "Email (Gmail)", label: "Gmail address", secret: false },
  { key: "SMTP_PASS", group: "Email (Gmail)", label: "Gmail App Password", secret: true, testable: true },
  { key: "SMTP_FROM", group: "Email (Gmail)", label: "From address (optional)", secret: false },
  { key: "OWNER_EMAIL", group: "Email (Gmail)", label: "Owner notification email", secret: false },

  { key: "IMAP_HOST", group: "Inbox (Gmail IMAP)", label: "IMAP Host", secret: false, placeholder: "imap.gmail.com" },
  { key: "IMAP_PORT", group: "Inbox (Gmail IMAP)", label: "IMAP Port", secret: false, placeholder: "993" },
  { key: "IMAP_SECURE", group: "Inbox (Gmail IMAP)", label: "IMAP Secure (true/false)", secret: false, placeholder: "true" },
  { key: "IMAP_USER", group: "Inbox (Gmail IMAP)", label: "Gmail address", secret: false },
  { key: "IMAP_PASS", group: "Inbox (Gmail IMAP)", label: "Gmail App Password", secret: true, testable: true },
  { key: "IMAP_MAILBOX", group: "Inbox (Gmail IMAP)", label: "Mailbox", secret: false, placeholder: "INBOX" },

  { key: "STRIPE_SECRET_KEY", group: "Payments", label: "Stripe Secret Key", secret: true, testable: true },
  { key: "RAZORPAY_KEY_ID", group: "Payments", label: "Razorpay Key ID", secret: false },
  { key: "RAZORPAY_KEY_SECRET", group: "Payments", label: "Razorpay Key Secret", secret: true, testable: true },

  { key: "FREELANCER_OAUTH_TOKEN", group: "Freelancer.com", label: "OAuth Token", secret: true, testable: true },
  { key: "FREELANCER_USER_ID", group: "Freelancer.com", label: "User ID", secret: false },

  { key: "GURU_API_KEY", group: "Guru.com", label: "API Key", secret: true },
];

const SETTINGS_KEYS = new Set(SETTINGS_MANIFEST.map((s) => s.key));

let cache = {};

export async function loadConfigCache() {
  const rows = await prisma.setting.findMany();
  const next = {};
  for (const row of rows) {
    try {
      next[row.key] = decrypt(row.value);
    } catch (err) {
      // Corrupted row or ENCRYPTION_KEY changed since it was written —
      // fall through to env var for this key rather than crashing startup.
      console.error(`[config] failed to decrypt setting "${row.key}", falling back to env var:`, err.message);
    }
  }
  cache = next;
}

export function getConfig(key) {
  if (cache[key] != null && cache[key] !== "") return cache[key];
  return process.env[key] || null;
}

/**
 * The kill switch. Every cron job in scheduler.js checks this first —
 * flipping it on stops all agents from doing anything new (in-flight work
 * finishes, nothing new starts) without touching code or infra. Toggled
 * from Admin Settings.
 */
export function isSystemPaused() {
  return String(getConfig("SYSTEM_PAUSED") || "").toLowerCase() === "true";
}

export function configSource(key) {
  if (cache[key] != null && cache[key] !== "") return "database";
  if (process.env[key]) return "environment";
  return "unset";
}

export async function setConfig(key, value) {
  if (!SETTINGS_KEYS.has(key)) throw new Error(`Unknown setting key: ${key}`);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: encrypt(value) },
    update: { value: encrypt(value) },
  });
  cache[key] = value;
}

/** Clears the DB override so the key falls back to its env var (if any). */
export async function clearConfig(key) {
  await prisma.setting.deleteMany({ where: { key } });
  delete cache[key];
}

/**
 * Backup/restore for the encrypted Setting table — protects against
 * losing every credential to a DB wipe or a bad migration. Exports the
 * ciphertext as-is (safe to store anywhere: it's useless without
 * ENCRYPTION_KEY), so restoring only works with the *same* ENCRYPTION_KEY
 * that created it — that key itself has no backup mechanism here since it
 * can't live in the thing it protects; losing it means every credential
 * must be re-entered from scratch. Document this clearly rather than
 * pretend a full solution exists.
 */
export async function exportSettingsBackup() {
  const rows = await prisma.setting.findMany();
  return { exportedAt: new Date().toISOString(), settings: rows.map((r) => ({ key: r.key, value: r.value })) };
}

export async function importSettingsBackup(backup) {
  const rows = backup?.settings;
  if (!Array.isArray(rows)) throw new Error("Backup must be { settings: [{ key, value }, ...] }");

  let imported = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row?.key || !row?.value || !SETTINGS_KEYS.has(row.key)) {
      failed += 1;
      continue;
    }
    try {
      decrypt(row.value); // verify it decrypts with the CURRENT key before trusting it
      await prisma.setting.upsert({
        where: { key: row.key },
        create: { key: row.key, value: row.value },
        update: { value: row.value },
      });
      cache[row.key] = decrypt(row.value);
      imported += 1;
    } catch {
      failed += 1; // wrong ENCRYPTION_KEY for this backup, or corrupted entry
    }
  }
  return { imported, failed };
}

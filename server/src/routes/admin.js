import { Router } from "express";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import Stripe from "stripe";
import Razorpay from "razorpay";
import { SETTINGS_MANIFEST, getConfig, setConfig, clearConfig, configSource } from "../services/config.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const adminRouter = Router();

function mask(value) {
  if (!value) return null;
  if (value.length <= 6) return "•".repeat(value.length);
  return value.slice(0, 3) + "•".repeat(Math.max(4, value.length - 6)) + value.slice(-3);
}

// Grouped view of every setting: whether it's set, where from (database vs
// env var vs unset), and a masked preview for secrets. Never returns a
// plaintext secret value.
adminRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const groups = {};
    for (const item of SETTINGS_MANIFEST) {
      const value = getConfig(item.key);
      groups[item.group] ??= [];
      groups[item.group].push({
        key: item.key,
        label: item.label,
        secret: item.secret,
        testable: !!item.testable,
        placeholder: item.placeholder || null,
        set: !!value,
        maskedValue: item.secret ? mask(value) : value,
        source: configSource(item.key),
      });
    }
    res.json({ groups });
  })
);

// Body: { KEY: "value", KEY2: "value2", ... } — only known keys are
// accepted; blank/undefined values are skipped (use /clear to remove one).
adminRouter.post(
  "/settings",
  asyncHandler(async (req, res) => {
    const updates = req.body || {};
    const validKeys = new Set(SETTINGS_MANIFEST.map((s) => s.key));
    const saved = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!validKeys.has(key) || value === "" || value == null) continue;
      await setConfig(key, String(value));
      saved.push(key);
    }
    res.json({ ok: true, saved });
  })
);

adminRouter.post(
  "/settings/:key/clear",
  asyncHandler(async (req, res) => {
    await clearConfig(req.params.key);
    res.json({ ok: true });
  })
);

// Lightweight, read-only connectivity checks — never send real
// jobs/emails/charges. Anthropic uses a 1-token request (negligible cost);
// SMTP/IMAP use their own protocol-level verify/connect; Stripe/Razorpay/
// Freelancer hit a cheap read-only endpoint.
const TESTERS = {
  ANTHROPIC_API_KEY: async () => {
    const apiKey = getConfig("ANTHROPIC_API_KEY");
    if (!apiKey) return { ok: false, message: "Not set" };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (res.ok) return { ok: true, message: "Connected" };
    const body = await res.text();
    return { ok: false, message: `API returned ${res.status}: ${body.slice(0, 200)}` };
  },
  SMTP_PASS: async () => {
    const t = nodemailer.createTransport({
      host: getConfig("SMTP_HOST"),
      port: Number(getConfig("SMTP_PORT") || 587),
      secure: getConfig("SMTP_SECURE") === "true",
      auth: { user: getConfig("SMTP_USER"), pass: getConfig("SMTP_PASS") },
    });
    await t.verify();
    return { ok: true, message: "Connected" };
  },
  IMAP_PASS: async () => {
    const client = new ImapFlow({
      host: getConfig("IMAP_HOST"),
      port: Number(getConfig("IMAP_PORT") || 993),
      secure: getConfig("IMAP_SECURE") !== "false",
      auth: { user: getConfig("IMAP_USER"), pass: getConfig("IMAP_PASS") },
      logger: false,
    });
    await client.connect();
    await client.logout();
    return { ok: true, message: "Connected" };
  },
  STRIPE_SECRET_KEY: async () => {
    const stripe = new Stripe(getConfig("STRIPE_SECRET_KEY"));
    await stripe.balance.retrieve();
    return { ok: true, message: "Connected" };
  },
  RAZORPAY_KEY_SECRET: async () => {
    const rp = new Razorpay({ key_id: getConfig("RAZORPAY_KEY_ID"), key_secret: getConfig("RAZORPAY_KEY_SECRET") });
    await rp.payments.all({ count: 1 });
    return { ok: true, message: "Connected" };
  },
  FREELANCER_OAUTH_TOKEN: async () => {
    const res = await fetch("https://www.freelancer.com/api/users/0.1/self/", {
      headers: { "Freelancer-OAuth-V1": getConfig("FREELANCER_OAUTH_TOKEN") },
    });
    return res.ok ? { ok: true, message: "Connected" } : { ok: false, message: `API returned ${res.status}` };
  },
};

adminRouter.post(
  "/settings/:key/test",
  asyncHandler(async (req, res) => {
    const tester = TESTERS[req.params.key];
    if (!tester) return res.status(400).json({ ok: false, message: "No connection test available for this setting" });
    try {
      const result = await tester();
      res.json(result);
    } catch (err) {
      res.json({ ok: false, message: String(err.message || err) });
    }
  })
);

import Stripe from "stripe";
import Razorpay from "razorpay";
import { getConfig } from "./config.js";

/**
 * Clients are built fresh from current config on each call rather than
 * cached at module load — keys can be added/changed at runtime via Admin
 * Settings, and constructing these SDK clients is cheap (no network call
 * until a method is actually invoked).
 */
function getStripe() {
  const key = getConfig("STRIPE_SECRET_KEY");
  return key ? new Stripe(key) : null;
}

function getRazorpay() {
  const keyId = getConfig("RAZORPAY_KEY_ID");
  const keySecret = getConfig("RAZORPAY_KEY_SECRET");
  return keyId && keySecret ? new Razorpay({ key_id: keyId, key_secret: keySecret }) : null;
}

/**
 * Provider choice: Razorpay for INR/India-based clients (UPI support),
 * Stripe for everything else (international cards). Both are optional —
 * without keys configured, invoices are created as MANUAL and the amount/
 * status just get tracked for reminders, no real charge link.
 */
export function pickProvider(currency) {
  if (currency === "INR" && getRazorpay()) return "RAZORPAY";
  if (getStripe()) return "STRIPE";
  return "MANUAL";
}

export async function createInvoiceLink({ provider, amount, currency, description, clientEmail }) {
  if (provider === "STRIPE") {
    const stripe = getStripe();
    if (!stripe) return null;
    const invoiceItem = await stripe.invoiceItems.create({
      customer: await ensureStripeCustomer(stripe, clientEmail),
      amount: Math.round(amount * 100),
      currency: currency.toLowerCase(),
      description,
    });
    const invoice = await stripe.invoices.create({ customer: invoiceItem.customer, auto_advance: true });
    await stripe.invoices.finalizeInvoice(invoice.id);
    return invoice.hosted_invoice_url;
  }

  if (provider === "RAZORPAY") {
    const razorpay = getRazorpay();
    if (!razorpay) return null;
    const link = await razorpay.paymentLink.create({
      amount: Math.round(amount * 100),
      currency,
      description,
      notify: { email: true, sms: false },
      customer: clientEmail ? { email: clientEmail } : undefined,
    });
    return link.short_url;
  }

  return null; // MANUAL provider: no auto invoice link, tracked for manual follow-up
}

async function ensureStripeCustomer(stripe, email) {
  if (!email) return (await stripe.customers.create({})).id;
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length) return existing.data[0].id;
  return (await stripe.customers.create({ email })).id;
}

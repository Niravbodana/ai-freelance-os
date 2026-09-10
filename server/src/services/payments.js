import Stripe from "stripe";
import Razorpay from "razorpay";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
    : null;

/**
 * Provider choice: Razorpay for INR/India-based clients (UPI support),
 * Stripe for everything else (international cards). Both are optional —
 * without keys configured, invoices are created as MANUAL and the amount/
 * status just get tracked for reminders, no real charge link.
 */
export function pickProvider(currency) {
  if (currency === "INR" && razorpay) return "RAZORPAY";
  if (stripe) return "STRIPE";
  return "MANUAL";
}

export async function createInvoiceLink({ provider, amount, currency, description, clientEmail }) {
  if (provider === "STRIPE" && stripe) {
    const invoiceItem = await stripe.invoiceItems.create({
      customer: await ensureStripeCustomer(clientEmail),
      amount: Math.round(amount * 100),
      currency: currency.toLowerCase(),
      description,
    });
    const invoice = await stripe.invoices.create({ customer: invoiceItem.customer, auto_advance: true });
    await stripe.invoices.finalizeInvoice(invoice.id);
    return invoice.hosted_invoice_url;
  }

  if (provider === "RAZORPAY" && razorpay) {
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

async function ensureStripeCustomer(email) {
  if (!email) return (await stripe.customers.create({})).id;
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length) return existing.data[0].id;
  return (await stripe.customers.create({ email })).id;
}

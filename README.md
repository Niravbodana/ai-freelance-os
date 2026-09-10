# ai-freelance-os

An AI-run freelance operation: agents find jobs, check whether we can
actually deliver them, draft/negotiate proposals, do the work, QA it,
invoice, and chase payment — running 24x7, with a human approval tap only
where a platform's own rules require it.

## Why proposals aren't 100% auto-sent everywhere

Upwork, Fiverr, and Freelancer all prohibit automated bidding in their
terms of service — an account caught auto-sending proposals risks a
permanent ban, wiping out all accumulated reputation in one shot. So on
those sources the Proposal Agent drafts and negotiates a rate, but a human
taps approve (from an email notification, one tap) before anything is
sent.

On sources we fully control — our own outreach (cold email/LinkedIn leads)
or direct/manual clients — there's no such restriction, so the Proposal
Agent sends automatically once a job passes the feasibility gate.

## Agent pipeline

1. **Hunter Agent** (`hunterAgent.js`) — polls registered job sources every
   15 min and inserts new jobs as `DISCOVERED`. Upwork has no public
   bidding API, so that adapter is a stub — wire in an RSS/search-result
   parser or a reviewed browser automation job there. Manual/outreach leads
   are added directly via the dashboard.
2. **Feasibility Agent** (`feasibilityAgent.js`) — the "if we can do it,
   take it; if not, skip it" gate. Every discovered job is checked against
   an explicit capability statement before a single word of proposal is
   written. Not feasible → `NOT_FEASIBLE`, owner notified with the reason,
   pipeline stops there. This is the single source of truth for what the
   system is allowed to say yes to — widen it deliberately, category by
   category.
3. **Proposal Agent** (`proposalAgent.js`) — drafts a tailored proposal
   with a market-researched rate. `OUTREACH`/`MANUAL` jobs auto-send;
   marketplace jobs go to `PENDING_APPROVAL` and notify the owner by email
   for a one-tap approve/edit.
4. **Worker Agent** (`workerAgent.js`) — MVP scope is the `content`
   category only, where a single AI pass reliably produces a deliverable
   matching the brief. Other categories route to manual fulfillment until a
   category-specific worker is built — a deliberate scope limit, not a
   placeholder to be silently widened.
5. **Delivery Agent** (`deliveryAgent.js`) — QA pass comparing the
   deliverable against the original brief before marking `DELIVERED`. A
   failed check keeps the job `IN_PROGRESS` instead of shipping bad work,
   and notifies the owner.
6. **Payment Agent** (`paymentAgent.js`) — invoices a delivered job via
   Stripe or Razorpay (picked by currency), tracks due date, and a
   scheduled sweep (every 6h) chases overdue invoices and notifies the
   owner. Nothing marks a job `PAID` automatically — that's a manual
   confirm or a provider webhook, never assumed.

Clients who pay across 2+ completed jobs are automatically flagged
`isRecurring` on their client record, for prioritizing repeat relationships.

## Notifications

Every event that needs a human — a marketplace proposal pending approval, a
job skipped as not feasible, a failed QA pass, an overdue payment, an agent
error — emails the owner (`OWNER_EMAIL`), so nothing needs the dashboard
open to be seen. Configure `SMTP_*` in `.env`; without it, events just log
to the console instead of failing silently.

## Stack

- **Backend**: Node/Express + PostgreSQL via Prisma (`server/`)
- **Frontend**: React + Vite — an approval queue / dashboard (`client/`)
- **AI**: Claude (Anthropic API) for drafting, negotiation, QA, feasibility
- **Payments**: Stripe (international) + Razorpay (INR/UPI)
- **Notifications**: Email (SMTP via nodemailer)

## Getting started

```bash
# Backend
cd server
cp .env.example .env   # fill in DATABASE_URL, ANTHROPIC_API_KEY, SMTP_*, payment keys
npm install
npm run prisma:migrate
npm run dev             # http://localhost:4000

# Frontend (separate terminal)
cd client
npm install
npm run dev              # http://localhost:5173
```

Stripe/Razorpay keys and SMTP are optional to get started — without them,
invoices are tracked as `MANUAL` (no auto link) and notifications just log
to the console.

## Roadmap

- [ ] Real Upwork job-source adapter (RSS/search parsing)
- [ ] Outreach lead capture (cold email/LinkedIn) feeding the same pipeline
- [ ] Category-specific Worker Agents beyond `content` (data, code)
- [ ] Client-facing status page per job
- [ ] Provider webhooks to auto-confirm payment instead of manual "mark paid"
- [ ] Gradually relax the marketplace approval gate per category once
      accuracy is proven — never by removing the gate itself, only by
      shrinking what needs it

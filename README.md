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

On sources we fully control — our own outreach (cold email/LinkedIn leads),
direct/manual clients, Freelancer.com (official self-service bidding API,
live once `FREELANCER_OAUTH_TOKEN`/`FREELANCER_USER_ID` are set), or a
public job board that published an apply-by-email address (they invited
applications; emailing them a proposal is a normal application, not spam)
— there's no such restriction, so the Proposal Agent sends automatically
once a job passes the feasibility gate. What this project will never do:
scrape login-walled pages, or auto-post pitches into comment sections/
social feeds where nobody asked for them — that's ToS-violating spam on
essentially every platform, and the fastest way to get every account and
the business itself banned. "Everywhere on the internet" means every
source that either has an official API or explicitly invites
applications, not literally anywhere.

## Agent pipeline

1. **Hunter Agent** (`hunterAgent.js`) — polls registered job sources every
   15 min and inserts new jobs as `DISCOVERED`. Live adapters
   (`agents/sources/`):
   - `remoteJobBoards.js` — RemoteOK's public JSON API + WeWorkRemotely's
     RSS feeds, both published for software to consume.
   - `freelancerCom.js` — Freelancer.com's official, self-service bidding
     API (developers.freelancer.com). A no-op until credentials are set;
     verify field/endpoint names against their current docs before
     depending on it, since third-party APIs drift.
   - `guruCom.js` — real adapter shape, but a deliberate no-op: Guru's API
     requires partner approval (not self-service like Freelancer's), so
     this stays disabled until you actually have credentials from them.
   - Upwork has no public bidding API at all, so that adapter stays a
     permanent stub — wiring in scraping/unofficial automation there would
     violate its ToS and risk the account.
   Manual/outreach leads are added directly via the dashboard.
2. **Feasibility Agent** (`feasibilityAgent.js`) — the "if we can do it,
   take it; if not, skip it" gate. Every discovered job is checked against
   an explicit capability statement before a single word of proposal is
   written. Not feasible → `NOT_FEASIBLE`, owner notified with the reason,
   pipeline stops there. This is the single source of truth for what the
   system is allowed to say yes to — widen it deliberately, category by
   category.
3. **Proposal Agent** (`proposalAgent.js`) — drafts a tailored proposal
   with a market-researched rate. Auto-sends for `OUTREACH`/`MANUAL` jobs,
   `REMOTE_BOARD` jobs with a published apply-by-email address (an actual
   email goes out), and `FREELANCER` jobs once API credentials are
   configured (a real bid is placed via their API; if the API call fails,
   it falls back to the approval queue rather than silently claiming it
   sent). Everything else — Upwork, Guru until its API is live — goes to
   `PENDING_APPROVAL` and notifies the owner by email for a one-tap
   approve/edit.
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
7. **Inbox Agent** (`inboxAgent.js`) — polls the configured mailbox every
   10 min (`services/inbox.js`, IMAP) for replies to emailed proposals,
   matches each one to its job by sender address, and classifies intent
   with Claude: `ACCEPTED` moves the job to `ACCEPTED` (the Pipeline Agent
   takes it from there); `REJECTED` closes it; `COUNTER_OFFER` notifies the
   owner with the countered rate — that's a real decision, not something
   auto-accepted; `QUESTION`/anything unclear notifies the owner with the
   message and an AI-drafted reply to review before sending. Only works for
   sources we emailed a proposal to (`applyEmail` set) — Upwork and other
   marketplace messaging still need the dashboard's manual "Mark
   accepted/rejected" buttons.
8. **Pipeline Agent** (`pipelineAgent.js`) — the self-driving state
   machine: every 10 min it finds `ACCEPTED` jobs with no deliverable and
   runs the Worker Agent, `IN_PROGRESS` jobs with an un-QA'd deliverable
   and runs the Delivery Agent, and `DELIVERED` jobs with no payment and
   invoices them. This is what makes "client says yes" the last moment a
   human needs to be involved — everything after it runs unattended on its
   own schedule, independent of whatever triggered the `ACCEPTED` status.

Clients who pay across 2+ completed jobs are automatically flagged
`isRecurring` on their client record, for prioritizing repeat relationships.

## Performance feedback loop

Every proposal's real outcome (`ACCEPTED`/`REJECTED`, from the Inbox Agent
or a manual mark) is recorded on the `Proposal` row. Before drafting a new
proposal, `services/performance.js` pulls the win rate and average accepted
vs. rejected rate for that job's category (once there are ≥3 outcomes to
trust) and feeds it straight into the Proposal Agent's prompt — so the rate
and pitch it writes next time are calibrated on what's actually been
winning, not guessed cold every time. The dashboard's performance table
shows the same numbers, so this isn't a black box.

## Command centre dashboard

`GET /api/stats` (the summary bar at the top of the dashboard, auto-
refreshing every 30s) gives a one-glance view of the whole operation:

- Jobs needing your approval, jobs in flight/delivered/paid, recurring
  clients, revenue collected vs. outstanding, overdue payments.
- **Claude usage**: tokens used and estimated cost this month, budget
  remaining (if you set `CLAUDE_MONTHLY_BUDGET_USD`), and the live
  `anthropic-ratelimit-*` headers from the most recent API call — that
  part is real data straight from the API, not an estimate. There's no
  API endpoint for "total account quota remaining" (that lives on
  console.anthropic.com's billing page), so cost tracking here is
  self-computed from every call's actual token usage — see `UsageLog` in
  the schema and `services/claude.js`.
- **Incidents**: how many failures are being auto-retried right now vs.
  how many actually need you (`ESCALATED`).

## Self-healing (automatic error handling)

Every agent failure becomes an `Incident` instead of just a log line. A
5-minute sweep (`services/incidents.js`, `retrySweep()`) retries it
automatically — up to `maxRetries` (default 3) — by re-running the exact
agent function that failed. Only once retries are exhausted, or a failure
has no automatic retry path (a system-level crash, a payment-sweep
failure), does it get `ESCALATED` and you get an email — that's the one
moment this system actually needs you; everything else is meant to fix
itself without anyone noticing. Process-level crashes (`uncaughtException`,
`unhandledRejection`) and any route error that slips past a handler's own
try/catch are also caught centrally (`index.js`) and escalated the same
way, so nothing fails silently into a dead process.

The dashboard's Incidents panel shows exactly this: an "needs you" section
for escalated incidents (with a resolve button once you've handled it),
and a collapsed "being retried automatically" section so the self-healing
loop isn't a black box.

## Notifications

Every event that needs a human — a marketplace proposal pending approval, a
job skipped as not feasible, a failed QA pass, an overdue payment, an
escalated incident — emails the owner (`OWNER_EMAIL`), so nothing needs the
dashboard open to be seen. Configure `SMTP_*` in `.env`; without it, events
just log to the console instead of failing silently.

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

## Deploying (Railway)

This repo runs as one service: the built dashboard is served by the same
Express process as the API (`server/src/index.js` serves `client/dist`),
so one deploy = one URL, and the dashboard's login works via a plain
browser prompt with no cross-origin complexity. `railway.json` at the repo
root already tells Railway how to build/start both halves.

1. **Get an Anthropic API key** — console.anthropic.com → sign up/sign in
   (needs your own email/payment method for API billing — this step can't
   be done on your behalf) → Settings → API Keys → Create Key. Copy it.
2. **Deploy on Railway** — railway.app → sign in with GitHub → New Project
   → Deploy from GitHub repo → pick this repo. Then:
   - **Add Postgres**: in the project, "New" → "Database" → "Add
     PostgreSQL". Railway creates a `DATABASE_URL` automatically.
   - On the app service's **Variables** tab, add a reference to the
     Postgres service's `DATABASE_URL` (Railway's "Add variable reference"
     button does this), then add the rest by hand: `ANTHROPIC_API_KEY`,
     `DASHBOARD_USER`, `DASHBOARD_PASSWORD` (pick your own login — this is
     what protects the whole dashboard, see below), and any of
     `SMTP_*`/`OWNER_EMAIL`/`IMAP_*`/`STRIPE_SECRET_KEY`/
     `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`FREELANCER_OAUTH_TOKEN`/
     `FREELANCER_USER_ID` you're ready to set (see `.env.example` for the
     full list and what each does — all except the first four are
     optional and can be added later).
   - Railway auto-deploys on push to this branch/repo from here on.
3. **Gmail App Password** (for `SMTP_*`/`IMAP_*`, i.e. notifications + the
   Inbox Agent) — needs 2-Step Verification turned on first: Google
   Account → Security → 2-Step Verification → App passwords → generate one
   for "Mail". Use that 16-character password for both `SMTP_PASS` and
   `IMAP_PASS` (not your normal Gmail password — Google blocks that for
   this). See `.env.example` for the exact Gmail host/port values.

**Security note**: `DASHBOARD_USER`/`DASHBOARD_PASSWORD` are required for
any deploy reachable from the internet — without them the dashboard and
every API action (creating jobs, approving proposals, marking payments
paid) has no login at all. The server logs a loud warning on startup if
they're unset; that's a real gap, not a convenience default.

## Roadmap

- [ ] Verify Claude per-token pricing in `.env` against your actual plan (defaults are placeholders)
- [ ] Guru.com API adapter once partner credentials are granted
- [ ] More RemoteOK/WeWorkRemotely-style public-feed job boards
- [ ] Outreach lead capture (cold email/LinkedIn) feeding the same pipeline
- [ ] Category-specific Worker Agents beyond `content` (data, code) — the
      Pipeline Agent already flags accepted jobs outside this scope for
      manual fulfillment, so widening Worker Agent's scope is what actually
      grows the automated volume
- [ ] Client-facing status page per job
- [ ] Provider webhooks to auto-confirm payment instead of manual "mark paid"
- [ ] Inbox Agent support for marketplace messaging (Upwork/Freelancer),
      not just email — currently only email-threaded sources auto-detect replies
- [ ] Gradually relax the marketplace approval gate per category once
      accuracy is proven — never by removing the gate itself, only by
      shrinking what needs it

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
   - `remoteJobBoards.js` — four genuinely public, no-signup, no-approval
     job feeds, live the moment the server starts: RemoteOK's JSON API,
     WeWorkRemotely's RSS, Remotive's JSON API, and Arbeitnow's JSON API.
     Verified live during development (91 real jobs discovered in one run).
   - `freelancerCom.js` — Freelancer.com's official, self-service bidding
     API (developers.freelancer.com). A no-op until credentials are set —
     and in practice Freelancer sometimes declines new-account API
     applications, so treat this as a bonus source, not a dependency;
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
4. **Worker Agent** (`workerAgent.js`) — scope is `content` and `data`
   (research/structured-data-summarization), each with its own prompt in
   `SYSTEM_PROMPTS`; `SUPPORTED_CATEGORIES` is the single source of truth
   the Pipeline Agent reads to decide what it can run unattended. Other
   categories route to manual fulfillment until a category-specific
   worker is added — a deliberate scope limit, not a placeholder to be
   silently widened.
5. **Delivery Agent** (`deliveryAgent.js`) — QA pass comparing the
   deliverable against the original brief before marking `DELIVERED`. A
   failed check keeps the job `IN_PROGRESS` instead of shipping bad work
   (see the revision loop, below), and on a pass **emails the finished
   work to the client** along with their status-page link. This was a
   real gap caught by re-reading the code while building the status page:
   QA passing only ever updated internal status — nothing had ever
   actually sent the client their work, so the invoice that follows would
   have asked them to pay for something they'd never seen.
6. **Payment Agent** (`paymentAgent.js`) — invoices a delivered job via
   Stripe or Razorpay (picked by currency), tracks due date, and a
   scheduled sweep (every 6h) chases overdue invoices and notifies the
   owner. Nothing marks a job `PAID` automatically — that's a manual
   confirm or a provider webhook, never assumed.
7. **Inbox Agent** (`inboxAgent.js`) — polls the configured mailbox every
   10 min (`services/inbox.js`, IMAP) for replies to emailed proposals,
   matches each one to its job by sender address, and classifies intent
   with Claude: `ACCEPTED` moves the job to `ACCEPTED` (the Pipeline Agent
   takes it from there); `REJECTED` closes it; `QUESTION`/anything unclear
   notifies the owner with the message and an AI-drafted reply to review
   before sending. `COUNTER_OFFER` is negotiated automatically within a
   band (see below) and only escalated to the owner outside it. Only
   works for sources we emailed a proposal to (`applyEmail` set) — Upwork
   and other marketplace messaging still need the dashboard's manual
   "Mark accepted/rejected" buttons.
8. **Pipeline Agent** (`pipelineAgent.js`) — the self-driving state
   machine: every 10 min it finds `ACCEPTED` jobs with no deliverable and
   runs the Worker Agent, `IN_PROGRESS` jobs with an un-QA'd deliverable
   *and no pending revision* and runs the Delivery Agent, `DELIVERED` jobs
   with no payment and invoices them, and `ACCEPTED` outreach/manual jobs
   with no contract yet and sends one (Contract Agent, below). This is
   what makes "client says yes" the last moment a human needs to be
   involved — everything after it runs unattended on its own schedule,
   independent of whatever triggered the `ACCEPTED` status.
9. **Testimonial Agent** (`testimonialAgent.js`) — fires automatically
   from `markPaid()`: emails the client a short, warm request for a
   testimonial/review once, guarded by `Payment.testimonialRequestedAt`.
   The reputation flywheel — a good outcome the performance feedback loop
   below can't see on its own (it only knows accepted/rejected rates).
10. **Leads Agent** (`leadsAgent.js`, `/api/leads/bulk-import`) —
    deliberately *not* a web-crawler that finds targets on its own
    (picking relevant, consensual outreach targets stays a business
    decision, not something automated); it takes a lead list you paste in
    (dashboard → Jobs tab → Bulk Outreach Import — company name, email,
    optional note per line) and turns each into a feasibility check + a
    personalized, auto-sent proposal. Same OUTREACH auto-send rules as
    everywhere else — no marketplace ToS applies to outreach you control.
11. **Contract Agent** (`contractAgent.js`) — sources with no
    platform-level terms of service behind them (`OUTREACH`/`MANUAL`; a
    marketplace's own ToS already covers Upwork/Freelancer/Guru
    engagements) get a plain-language service agreement emailed
    automatically on acceptance (scope, rate, payment terms, revision
    policy, IP transfer on payment) — a paper trail, not a lawyer
    replacement, but real protection if a payment dispute ever comes up.
    Fires once per job (`Job.contractSentAt`).

**Auto-negotiation**: when the Inbox Agent detects a `COUNTER_OFFER`, it
compares the countered rate to the original ask — within 20%
(`ACCEPTABLE_COUNTER_BAND` in `inboxAgent.js`) it auto-accepts, confirms
with the client by email, and updates the proposal's rate, so a deal that's
clearly fine doesn't sit waiting on a human. Outside that band it still
notifies the owner for a real decision, same as before.

**The revision loop**: a failed QA pass, or a client emailing back after
delivery asking for a change, both set `Deliverable.needsRevision` with the
specific feedback attached (`qaFeedback`/`revisionNotes`). Worker Agent
reads that feedback on its next run instead of blindly regenerating from
scratch, and Pipeline Agent only re-runs Delivery Agent's QA check once a
revision has actually happened — earlier versions of this loop re-checked
the same unrevised content forever instead of giving Worker Agent a turn to
fix it; this was caught and fixed via live testing, not designed in from
the start. The Inbox Agent also now watches replies on `DELIVERED`/
`AWAITING_PAYMENT` jobs (not just pre-acceptance ones), classifying them as
`SATISFIED` (no action) or `REVISION_REQUEST` (feeds the loop above).

**The deposit gate**: a first-time (non-recurring) `OUTREACH`/`MANUAL`
client has no track record and no platform escrow behind them. Pipeline
Agent invoices a real 50% deposit automatically (`Payment.kind: DEPOSIT`)
and Worker Agent is held back until it's actually marked `PAID` — no more
doing full unpaid work for a stranger. Trusted jobs (platform-sourced, or
a client already flagged `isRecurring`) skip straight to Worker Agent as
before, no deposit involved. The final invoice for a job that took a
deposit is automatically the *remaining* balance, not the full amount
again. A `Job`/`Payment` can carry up to one `DEPOSIT` and one `FINAL`
payment (`@@unique([jobId, kind])`) — this replaced an earlier, weaker
version of this feature that only left an advisory note for the owner
rather than actually gating the work.

Clients who pay across 2+ completed jobs are automatically flagged
`isRecurring` on their client record, for prioritizing repeat relationships.

## Weekly digest

**Digest Agent** (`digestAgent.js`) emails one summary every Monday
8am UTC: jobs won/active, revenue collected, testimonial requests sent,
and what needs attention right now (pending approvals, overdue payments,
escalated incidents) — so staying on top of the business doesn't require
opening the dashboard. Trigger it on demand from Command Centre's "Send
weekly digest now" button, or `POST /api/agents/digest/run`.

## Clients dashboard

A dedicated **Clients** tab shows every client the business has ever
dealt with — one card per client with their platform, recurring status,
every job and its status, and a real financial summary computed straight
from `Payment` rows: **received** (sum of `PAID` payments) and
**remaining/outstanding** (sum of invoiced-but-unpaid ones), never
guessed. Backed by `GET /api/clients` (`routes/clients.js`).

**Audit finding fixed while building this**: a `Client` record only ever
got created for `OUTREACH` leads imported via `leadsAgent.js` — every
job discovered by the Hunter Agent from the job boards that are actually
live right now (RemoteOK, WeWorkRemotely, Remotive, Arbeitnow) had
`clientId: null` forever, since nothing attached one. That silently broke
two things: recurring-client detection (`paymentAgent.js` counts `PAID`
jobs by `clientId`, so it never fired for board-sourced work) and any
per-client view of the business, since the majority of real job volume
had nothing to group by. Fixed by `services/clients.js`'s
`findOrCreateClient()` (dedupes by email), now called wherever a job
gets an apply-email: the Hunter Agent's job-board adapters, and the
manual "Add a job" form (which now has an optional client-email field
for exactly this). Verified live: a manually created job with a client
email correctly created and linked a `Client` row, visible immediately
in the Clients tab.

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

A dark, HUD-style dashboard (three tabs: Command Centre, Jobs, Admin
Settings) that auto-refreshes every 30s. `GET /api/stats` (the tile grid at
the top of Command Centre) gives a one-glance view of the whole operation:

- Jobs needing your approval, jobs in flight/delivered/paid, recurring
  clients, revenue collected vs. outstanding, overdue payments.
- **Monthly revenue estimate** — trailing 30-day actual paid revenue, with
  an explicit confidence label (`insufficient-data` under 3 paid jobs,
  `early` under 10, `established` beyond that) rather than a number
  presented as more certain than the data behind it actually is.
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
- **Live Agent Activity** — a terminal-style feed of every agent run
  (Hunter, Feasibility, Proposal, Worker, Delivery, Payment, Inbox,
  Pipeline) as it happens, polling independently every 8s.
- **Export payments CSV** — every payment row (job, provider, amount,
  status, dates) as a plain CSV, for accounting/tax filing without
  querying the database by hand.

## Client status page

Every job gets a private, unguessable link (`Job.statusToken`,
`/status/:token`) a client can open without any login — deliberately
excluded from the dashboard's basic auth (see `index.js`) since it's the
one page meant for someone other than the owner. Shows a client-friendly
status label (never the internal enum or anything like feasibility notes
or negotiation logs), the finished work once delivered, and the invoice
link once invoiced. Included automatically in the Delivery Agent's
"work is done" email; also shown on each job's card in the dashboard for
manually sharing.

## Admin Settings — every credential, in one place

The **Admin Settings** tab holds every credential the system uses (Claude
API key, Gmail SMTP/IMAP, Stripe/Razorpay, Freelancer.com), editable right
in the dashboard after its own login — no separate admin account, the
basic-auth prompt you already log into *is* the admin login. Each item
shows a connected/disconnected status pill and a one-click **Test**
button that does a real, cheap, read-only connectivity check (SMTP
`transporter.verify()`, an IMAP connect+logout, a 1-token Claude call, a
Stripe balance read, etc.) — never sends a real email/proposal/charge.

Values are AES-256-GCM encrypted at rest (`services/crypto.js`) and never
sent back to the browser in plaintext, only masked (`sk-•••••••key`). A
setting entered here overrides the matching env var; leaving it unset
falls back to the env var, so existing Railway env-var configuration
keeps working untouched — Admin Settings is additive, not required. The
one exception is the four bootstrap secrets (`DATABASE_URL`,
`DASHBOARD_USER`, `DASHBOARD_PASSWORD`, `ENCRYPTION_KEY`) which must stay
env vars — the app needs them before it can even read the database, or as
the key that unlocks every encrypted value stored there.

**Backup & Restore** (top of the Admin Settings tab): downloads every
credential's encrypted ciphertext as JSON — safe to store anywhere,
useless without `ENCRYPTION_KEY` — and can restore from that file later.
This protects against losing every credential to a database wipe or a bad
migration. It does **not** protect against losing `ENCRYPTION_KEY` itself
— that key can't have a backup mechanism inside the thing it protects;
losing it means every credential must be re-entered from scratch. Treat
it like you'd treat a master password.

## Cost optimization

Two real levers, not the obvious-looking one:

- **Model tiering** (`services/claude.js`): simple, well-scoped
  classification — feasibility check, delivery QA pass/fail, inbox reply
  intent — runs on Claude Haiku 4.5 (`MODELS.CLASSIFY`, roughly half
  Sonnet 5's per-token price). Proposal/content drafting, which is
  quality-sensitive, stays on Claude Sonnet 5 (`MODELS.GENERATE`).
- **Thinking disabled** on Sonnet 5 calls: adaptive thinking is on by
  default and none of this app's calls are multi-step reasoning tasks, so
  `thinking: {type: "disabled"}` is set explicitly rather than paying for
  a default that doesn't earn its cost here.

**What's deliberately *not* done**: prompt caching on the system prompts.
Every system prompt in this app (~100-200 tokens) sits below every
current model's minimum cacheable prefix (1024 tokens on Sonnet 5, 4096
on Haiku 4.5), so `cache_control` on them would create zero cache hits —
`cache_read_input_tokens` would stay 0 forever. Padding prompts just to
cross that threshold would cost more than it saves. If a future prompt
genuinely grows past the threshold (e.g. a long style guide or examples
block), caching becomes worth revisiting.

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
- **Frontend**: React + Vite — a dark HUD-style command centre (`client/`)
- **AI**: Claude (Anthropic API) — Sonnet 5 for drafting, Haiku 4.5 for classification (see Cost optimization)
- **Payments**: Stripe (international) + Razorpay (INR/UPI)
- **Notifications**: Email (SMTP via nodemailer)
- **Credentials**: AES-256-GCM encrypted in Postgres, editable from Admin Settings

## Getting started

```bash
# Backend
cd server
cp .env.example .env   # fill in DATABASE_URL, DASHBOARD_USER/PASSWORD, ENCRYPTION_KEY (bootstrap);
                        # ANTHROPIC_API_KEY/SMTP/payments can go here too, or wait and set them in Admin Settings
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

## Testing

`cd server && npm test` runs a regression suite (`node:test`, no extra
dependency) against a real Postgres via `DATABASE_URL` — use a scratch/dev
database, not production, since it creates and deletes real rows.
`test/pipeline.test.js` covers the exact bug class the revision loop fixed
(see "The revision loop" above): it asserts a `needsRevision` job is
routed to Worker Agent, never re-checked by Delivery Agent on stale
content, found via manual live testing rather than caught by a test
originally — this suite exists so that specific regression can't recur
silently.

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
     button does this), then set the other three bootstrap vars by hand:
     `DASHBOARD_USER`, `DASHBOARD_PASSWORD` (pick your own login — this is
     what protects the whole dashboard, see below) and `ENCRYPTION_KEY`
     (any random string — it encrypts every credential you enter in Admin
     Settings, so treat it like a password and don't lose it).
   - That's it for env vars. `ANTHROPIC_API_KEY` and everything else
     (SMTP/IMAP, Stripe/Razorpay, Freelancer.com) can now be entered
     straight into the **Admin Settings** tab after your first login,
     instead of the Railway dashboard — see below. Setting them as env
     vars here still works exactly the same if you'd rather.
   - Railway auto-deploys on push to this branch/repo from here on.
3. **Gmail App Password** (for SMTP/IMAP, i.e. notifications + the Inbox
   Agent) — needs 2-Step Verification turned on first: Google Account →
   Security → 2-Step Verification → App passwords → generate one for
   "Mail". Use that 16-character password for both the SMTP and IMAP
   password fields (not your normal Gmail password — Google blocks that
   for this). Enter it in Admin Settings (or `.env.example` has the exact
   Gmail host/port values if you'd rather use env vars).

**Security note**: `DASHBOARD_USER`/`DASHBOARD_PASSWORD` are required for
any deploy reachable from the internet — without them the dashboard and
every API action (creating jobs, approving proposals, marking payments
paid) has no login at all. The server logs a loud warning on startup if
they're unset; that's a real gap, not a convenience default.

## External uptime monitoring

Railway restarts the process on a crash, but nothing outside the process
notices if it hangs without crashing (stuck event loop, DB connection pool
exhausted, etc.) — the cron schedulers would silently stop firing and
nobody would know. `GET /health` (`server/src/index.js`) already exists
for exactly this and is deliberately excluded from basic auth so an
external monitor can hit it with no credentials. This is a 5-minute setup
on a free third-party service — it's not built into this codebase because
it inherently has to run outside the process it's watching:

1. **Sign up** at [UptimeRobot](https://uptimerobot.com) (free tier covers
   this — 50 monitors, 5-minute checks) with any email.
2. **Add New Monitor** → Monitor Type: `HTTP(s)` → Friendly Name: `AI
   Freelance OS` → URL: `https://<your-railway-app-url>/health` → Monitoring
   Interval: 5 minutes (free tier minimum).
3. **Add an Alert Contact** (Settings → Alert Contacts) — email is
   instant and free; UptimeRobot also supports SMS/Slack/webhook on paid
   tiers if you want a louder ping later. Attach that contact to the
   monitor when creating it.
4. **Save.** UptimeRobot now polls `/health` every 5 minutes and emails you
   the moment it stops returning `{ ok: true }` with a 200 — which covers
   both a crashed process (Railway will already be restarting it, but now
   you know) and a hung one that never crashes but also never responds.
5. Optional: add a **public status page** (UptimeRobot → Status Pages) if
   you ever want clients to see uptime history — not required for the
   alerting to work.

This closes the one monitoring gap that has to live outside the app: it
tells you the moment the system stops running, instead of you finding out
because a job silently stopped moving through the pipeline.

## Roadmap

- [ ] Verify Claude per-token pricing in `.env` against your actual plan (defaults are placeholders)
- [ ] Guru.com API adapter once partner credentials are granted
- [ ] Freelancer.com adapter once/if API access is approved (Remotive +
      Arbeitnow + RemoteOK + WeWorkRemotely already give no-auth volume
      that doesn't depend on it)
- [ ] Worker Agent scope beyond `content`/`data` (e.g. `code`) — same
      pattern as adding `data` was: a new prompt in `SYSTEM_PROMPTS` plus
      adding the category to `SUPPORTED_CATEGORIES`
- [ ] Provider webhooks to auto-confirm payment instead of manual "mark paid"
- [ ] Inbox Agent support for marketplace messaging (Upwork/Freelancer),
      not just email — currently only email-threaded sources auto-detect replies
- [ ] Capture testimonial replies automatically (currently the request goes
      out; the reply is read by the owner directly, not parsed/stored)
- [ ] A real deposit-before-work payment gate (currently an advisory
      incident, not automated) — needs Payment to support more than one
      row per job (deposit + final), a bigger schema/state-machine change
      deliberately deferred rather than rushed
- [ ] Gradually relax the marketplace approval gate per category once
      accuracy is proven — never by removing the gate itself, only by
      shrinking what needs it
- [ ] More regression tests as the pipeline state machine grows — the one
      that exists was written after a bug was found live, not before;
      more of the agent-routing logic deserves the same coverage

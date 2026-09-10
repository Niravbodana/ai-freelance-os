# ai-freelance-os

An AI-run freelance operation: agents find jobs, draft proposals, do the
work, and QA it before delivery — running on a 24x7 loop with a human
approval gate before any proposal actually goes out.

## Why a human approval gate

Upwork, Fiverr, and Freelancer all prohibit automated bidding in their
terms of service — an account caught auto-sending proposals risks a
permanent ban. So the Proposal Agent drafts, but a human clicks approve
before anything is sent. This is also why an "outreach" job source (cold
email/LinkedIn leads you add yourself) exists alongside Upwork: it isn't
subject to platform bidding restrictions.

## Agent pipeline

1. **Hunter Agent** (`server/src/agents/hunterAgent.js`) — polls registered
   job sources on a cron (every 15 min) and inserts new jobs as
   `DISCOVERED`. Upwork has no public bidding API, so that adapter is a
   stub — wire in an RSS/search-result parser or a reviewed browser
   automation job there. Manual/outreach leads are added directly via the
   dashboard.
2. **Proposal Agent** (`proposalAgent.js`) — drafts a tailored proposal
   with Claude, sets the job to `PENDING_APPROVAL`. Nothing is sent until
   a human approves (and can edit) it from the dashboard.
3. **Worker Agent** (`workerAgent.js`) — MVP scope is the `content`
   category only, where a single AI pass reliably produces a deliverable
   matching the brief. Other categories should route to manual fulfillment
   until a category-specific worker is built — this is a deliberate scope
   limit, not a placeholder to be silently widened.
4. **Delivery Agent** (`deliveryAgent.js`) — runs a QA pass comparing the
   deliverable against the original brief before marking a job
   `DELIVERED`. A failed QA check keeps the job `IN_PROGRESS` instead of
   shipping bad work.

## Stack

- **Backend**: Node/Express + PostgreSQL via Prisma (`server/`)
- **Frontend**: React + Vite — an approval queue / dashboard (`client/`)
- **AI**: Claude (Anthropic API) for drafting and QA

## Getting started

```bash
# Backend
cd server
cp .env.example .env   # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm install
npm run prisma:migrate
npm run dev             # http://localhost:4000

# Frontend (separate terminal)
cd client
npm install
npm run dev              # http://localhost:5173
```

## Roadmap

- [ ] Real Upwork job-source adapter (RSS/search parsing)
- [ ] Outreach lead capture (cold email/LinkedIn) feeding the same pipeline
- [ ] Category-specific Worker Agents beyond `content` (data, code)
- [ ] Client-facing status page per job
- [ ] Gradually relax the approval gate per category once accuracy is proven

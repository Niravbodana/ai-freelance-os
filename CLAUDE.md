# Claude handoff — ai-freelance-os

This is the **working Node/React product**, not the empty `main` README-only repo and not the unused Python FastAPI scaffold on `copilot/add-user-authentication`.

Default branch to continue from: **`main`** (fast-forwarded to include the full app + isometric Office). Older work also lived on `claude/isko-study-vision-5hn524`.

## What just landed

Office tab is the founder-provided isometric floor plan:

- Artwork: `client/public/office-floor.jpg`
- Overlay + roster: `client/src/components/OfficeView.jsx`
- Styles: `client/src/office.css`

Do **not** rebuild the old cubicle-card office. Keep the floor plate looking like the illustration (Meeting Room, Founder, Pantry, Discussion, Collaboration, HR). Live agent status goes on pins + the bottom inspect/roster dock, not extra cartoon people on sofas.

## How to run

```bash
# server
cd server
cp .env.example .env   # DATABASE_URL, DASHBOARD_USER, DASHBOARD_PASSWORD, ENCRYPTION_KEY
npm install
npx prisma migrate deploy
npm run dev            # :4000

# client
cd client
npm install
npm run dev            # :5173, proxies /api → :4000
```

`ANTHROPIC_API_KEY` and SMTP can wait — set them in Admin Settings after login. Without them the dashboard still loads; agents will not actually call Claude.

## Layout

- `server/src/agents/` — Hunter, Feasibility, Proposal, Worker, Delivery, Payment, Inbox, Pipeline, Contract, Digest, Leads, Testimonial
- `server/src/routes/` — HTTP API
- `server/prisma/schema.prisma` — source of truth for models
- `client/src/App.jsx` — tabs: Office, Command Centre, Proposals, Jobs, Clients, Admin Settings

Full product notes and ToS rules: `README.md`. Open follow-ups: `README.md` → Roadmap.

## Do not

- Scrape login-walled job boards or auto-bid on Upwork/Fiverr (ToS).
- Merge or revive `copilot/add-user-authentication` as a second app — it is a separate Python scaffold.
- Put roaming SVG people on the isometric floor; it breaks the illustration.

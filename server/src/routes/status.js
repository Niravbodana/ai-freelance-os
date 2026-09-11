import { Router } from "express";
import { prisma } from "../db/client.js";

export const statusRouter = Router();

// Client-facing status, not the admin status enum — deliberately vague on
// internal states (NOT_FEASIBLE, PENDING_APPROVAL, etc. never reach a
// client) and never includes anything internal: feasibility notes,
// negotiation logs, incident data.
const CLIENT_FRIENDLY_STATUS = {
  DISCOVERED: "Reviewing your request",
  PENDING_APPROVAL: "Reviewing your request",
  PROPOSAL_SENT: "Proposal sent — awaiting your response",
  ACCEPTED: "Confirmed — work starting",
  IN_PROGRESS: "In progress",
  DELIVERED: "Delivered — invoice to follow shortly",
  AWAITING_PAYMENT: "Delivered — invoice sent",
  PAID: "Complete — paid in full",
  REJECTED: "Closed",
  CLOSED: "Closed",
};

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage({ title, status, deliverableContent, depositUrl, invoiceUrl }) {
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project Status — ${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;background:#f7f9fb;color:#1a1a1a;max-width:640px;margin:40px auto;padding:0 16px;}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:24px;}
.status{display:inline-block;background:#e8f7f0;color:#0a7;border-radius:20px;padding:4px 14px;font-size:13px;font-weight:600;margin:8px 0 16px;}
pre{white-space:pre-wrap;background:#f2f2f2;border-radius:6px;padding:14px;font-size:14px;}
a.btn{display:inline-block;background:#0a7;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;margin-top:12px;margin-right:8px;}
</style></head>
<body>
<div class="card">
<h2>${escapeHtml(title)}</h2>
<span class="status">${escapeHtml(status)}</span>
${deliverableContent ? `<h3>Delivered work</h3><pre>${escapeHtml(deliverableContent)}</pre>` : ""}
${depositUrl ? `<a class="btn" href="${escapeHtml(depositUrl)}" target="_blank" rel="noreferrer">Pay deposit to start</a>` : ""}
${invoiceUrl ? `<a class="btn" href="${escapeHtml(invoiceUrl)}" target="_blank" rel="noreferrer">View invoice</a>` : ""}
</div>
</body></html>`;
}

// GET /status/:token — a private, unguessable link (Job.statusToken) so
// clients can check progress without a dashboard login. Intentionally NOT
// under /api and NOT behind the dashboard's basic auth (see index.js) —
// this is the one page meant for someone other than the owner to see.
statusRouter.get("/:token", async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { statusToken: req.params.token },
    include: { deliverable: true, payments: true },
  });
  if (!job) return res.status(404).send("Not found");

  const deposit = job.payments.find((p) => p.kind === "DEPOSIT");
  const final = job.payments.find((p) => p.kind === "FINAL");
  const depositPending = job.status === "ACCEPTED" && deposit && deposit.status !== "PAID";

  res.set("Content-Type", "text/html");
  res.send(
    renderPage({
      title: job.title,
      status: depositPending ? "Awaiting deposit payment to start work" : CLIENT_FRIENDLY_STATUS[job.status] || "In progress",
      deliverableContent: ["DELIVERED", "AWAITING_PAYMENT", "PAID"].includes(job.status) ? job.deliverable?.content : null,
      depositUrl: deposit && deposit.status !== "PAID" ? deposit.invoiceUrl : null,
      invoiceUrl: final?.invoiceUrl,
    })
  );
});

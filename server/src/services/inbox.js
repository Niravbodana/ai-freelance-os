import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "../db/client.js";

const MAILBOX = process.env.IMAP_MAILBOX || "INBOX";

function isConfigured() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

/**
 * Fetches every email that arrived since the last check, using IMAP UIDs
 * (not dates) so nothing is double-processed or skipped across restarts.
 * Most providers need an app password for this (Gmail: 2FA + app password
 * under Google Account > Security; Outlook similarly) rather than your
 * normal login password — see README.
 */
export async function fetchNewEmails() {
  if (!isConfigured()) return [];

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });

  const emails = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock(MAILBOX);
    try {
      const state = await prisma.inboxState.upsert({
        where: { mailbox: MAILBOX },
        create: { mailbox: MAILBOX, lastUid: 0 },
        update: {},
      });

      // First run ever: don't replay the whole mailbox history — start
      // from "now" so only genuinely new replies get processed.
      const searchFrom = state.lastUid === 0 ? client.mailbox.uidNext - 1 : state.lastUid;

      let maxUidSeen = state.lastUid;
      for await (const message of client.fetch(
        { uid: `${searchFrom + 1}:*` },
        { envelope: true, source: true, uid: true }
      )) {
        if (message.uid <= searchFrom) continue;
        maxUidSeen = Math.max(maxUidSeen, message.uid);

        const parsed = await simpleParser(message.source);
        emails.push({
          uid: message.uid,
          from: parsed.from?.value?.[0]?.address || "",
          subject: parsed.subject || "",
          text: (parsed.text || "").slice(0, 5000),
        });
      }

      if (maxUidSeen > state.lastUid) {
        await prisma.inboxState.update({ where: { mailbox: MAILBOX }, data: { lastUid: maxUidSeen } });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  return emails;
}

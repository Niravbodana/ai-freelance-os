import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "../db/client.js";
import { getConfig } from "./config.js";

function isConfigured() {
  return Boolean(getConfig("IMAP_HOST") && getConfig("IMAP_USER") && getConfig("IMAP_PASS"));
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

  const mailbox = getConfig("IMAP_MAILBOX") || "INBOX";

  const client = new ImapFlow({
    host: getConfig("IMAP_HOST"),
    port: Number(getConfig("IMAP_PORT") || 993),
    secure: getConfig("IMAP_SECURE") !== "false",
    auth: { user: getConfig("IMAP_USER"), pass: getConfig("IMAP_PASS") },
    logger: false,
  });

  // ImapFlow emits an 'error' event on socket/connection problems (a slow
  // network hiccup, a timeout) — an EventEmitter 'error' with no listener
  // is fatal in Node, crashing straight past every try/catch here and
  // showing up as a top-level PROCESS_UNCAUGHT_EXCEPTION "Socket timeout"
  // incident that reappears no matter how many times it's marked resolved,
  // since it's a brand new crash each time, not the same stuck one. This
  // listener turns it into a normal, recoverable failure instead: the
  // client.connect()/fetch() call below still rejects normally and gets
  // caught by processInbox()'s own try/catch (source: "INBOX"), which is
  // already in the retry queue like every other agent failure.
  client.on("error", (err) => console.error("[inbox] IMAP client error (recovered):", err.message));

  const emails = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const state = await prisma.inboxState.upsert({
        where: { mailbox },
        create: { mailbox, lastUid: 0 },
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
        await prisma.inboxState.update({ where: { mailbox }, data: { lastUid: maxUidSeen } });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  return emails;
}

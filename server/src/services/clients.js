import { prisma } from "../db/client.js";

/**
 * Finds (by email) or creates the Client record a job belongs to. Before
 * this existed, only OUTREACH leads imported via leadsAgent.js ever got a
 * Client row — every job-board-sourced job (RemoteOK/WeWorkRemotely/
 * Remotive/Arbeitnow, the sources that are actually live with no API key
 * needed) had `clientId: null` forever. That silently broke two things:
 * recurring-client detection (paymentAgent.js counts PAID jobs by
 * clientId) and any per-client view of the business, since there was
 * nothing to group by. Called wherever a job with an email is created.
 */
export async function findOrCreateClient({ email, name, platform }) {
  if (!email) return null;

  const existing = await prisma.client.findFirst({ where: { email } });
  if (existing) return existing;

  return prisma.client.create({
    data: { name: name || email, email, platform },
  });
}

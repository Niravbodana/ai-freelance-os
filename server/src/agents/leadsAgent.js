import { prisma } from "../db/client.js";
import { checkFeasibility } from "./feasibilityAgent.js";
import { draftProposal } from "./proposalAgent.js";

/**
 * Leads Agent — turns a lead list YOU curate (exported from LinkedIn Sales
 * Navigator, a purchased B2B list, companies you've noticed need the
 * work) into automated, personalized outreach. This is deliberately NOT a
 * web-crawler that goes and discovers targets on its own — deciding who's
 * a relevant, consensual outreach target is a business judgment call that
 * stays yours; what this automates is turning that list into a
 * personalized pitch per lead and sending it (OUTREACH source auto-sends,
 * same as everywhere else in this app — no marketplace ToS applies to
 * outreach you control).
 */
export async function importLead({ companyName, contactEmail, note, category = "content" }) {
  if (!companyName || !contactEmail) {
    throw new Error("companyName and contactEmail are required");
  }

  let client = await prisma.client.findFirst({ where: { email: contactEmail } });
  if (!client) {
    client = await prisma.client.create({ data: { name: companyName, email: contactEmail, platform: "OUTREACH" } });
  }

  const job = await prisma.job.create({
    data: {
      source: "OUTREACH",
      title: `Outreach: ${companyName}`,
      description:
        note?.trim() ||
        `Cold outreach to ${companyName} — no specific brief given, pitch general ${category} services and ask what they need.`,
      category,
      applyEmail: contactEmail,
      clientId: client.id,
      status: "DISCOVERED",
    },
  });

  const { feasible, note: feasibilityNote } = await checkFeasibility(job.id);
  if (feasible) {
    await draftProposal(job.id);
  }

  return { jobId: job.id, feasible, feasibilityNote };
}

export async function importLeadsBulk(leads) {
  const results = [];
  for (const lead of leads) {
    try {
      const result = await importLead(lead);
      results.push({ ...lead, ...result });
    } catch (err) {
      results.push({ ...lead, error: err.message });
    }
  }
  return results;
}

/**
 * Guru.com — unlike Freelancer.com, Guru does not run a self-service
 * developer portal; API/partner access is granted case-by-case by Guru's
 * business team. So this adapter is a real, ready-to-use shape, but it's a
 * deliberate no-op until GURU_API_KEY is actually issued to you — returning
 * fabricated project data or guessing undocumented endpoints would be
 * worse than just being honest that this integration is pending approval.
 *
 * To activate: request API access from Guru, drop the real base URL/auth
 * scheme they give you into this file, and register the adapter in
 * hunterAgent.js the same way freelancerComAdapter is registered.
 */
import { getConfig } from "../../services/config.js";

export async function guruComAdapter() {
  if (!getConfig("GURU_API_KEY")) return [];
  console.warn("[guruCom] GURU_API_KEY is set but this adapter is a stub — see comments in guruCom.js");
  return [];
}

export async function placeGuruBid() {
  return { placed: false, reason: "Guru API integration pending partner approval — see guruCom.js" };
}

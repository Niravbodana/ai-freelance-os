import { Router } from "express";
import { importLeadsBulk } from "../agents/leadsAgent.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const leadsRouter = Router();

// Body: { leads: [{ companyName, contactEmail, note?, category? }, ...] }
leadsRouter.post(
  "/bulk-import",
  asyncHandler(async (req, res) => {
    const leads = req.body?.leads;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: "Body must be { leads: [{ companyName, contactEmail, note?, category? }, ...] }" });
    }
    const results = await importLeadsBulk(leads);
    res.json({ results });
  })
);

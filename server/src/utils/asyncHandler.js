/**
 * Express 4 does not automatically catch a rejected promise from an async
 * route handler — an unhandled agent-call error inside one hangs the
 * request forever and only surfaces as a process-level unhandledRejection.
 * Wrap every route with this so a thrown/rejected error always reaches
 * Express's error-handling middleware (and a real HTTP response) instead.
 * Found via live testing: POST /api/jobs had no try/catch around
 * checkFeasibility/draftProposal, so a Claude API failure there hung the
 * request and only showed up as a process crash — exactly the class of bug
 * this wrapper closes off for every route, not just that one.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const { AppError } = require("../errors/AppError");

/**
 * PDP rollout P2 (Q8): member-portal self-service routes are for PORTAL callers only.
 *
 * `portal:read` / `portal:write` alone does not separate the surfaces: a CRM role that holds a
 * `portal:*` code (several do today) could otherwise reach the portal controller, whose
 * "own issue" model (caller in memberIds) is not the CRM team-visibility model. The caller type
 * comes from the authenticated identity only (req.user.userType, set by middlewares/auth.js from
 * the gateway-verified headers or the verified token) - never from the body or query. A missing
 * or any other userType (CRM, SYSTEM, ...) is refused. CRM staff use the CRM issue routes.
 */
function requirePortalUser(req, res, next) {
  const userType = req.user && typeof req.user.userType === "string" ? req.user.userType.trim().toUpperCase() : "";
  if (userType === "PORTAL") return next();
  return next(AppError.forbidden("This endpoint is only available for Portal users", { code: "PORTAL_ONLY" }));
}

module.exports = { requirePortalUser };

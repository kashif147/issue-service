const axios = require("axios");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL || process.env.POLICY_SERVICE_URL || "http://user-service:5001";

function buildHeaders(req, tenantId) {
  const headers = {
    "Content-Type": "application/json",
    "x-tenant-id": tenantId || "",
    "x-internal-request": "true",
  };
  if (req?.headers?.authorization) {
    headers.authorization = req.headers.authorization;
  }
  for (const key of [
    "x-jwt-verified",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
  ]) {
    if (req?.headers?.[key]) {
      headers[key] = req.headers[key];
    }
  }
  return headers;
}

/**
 * Users holding any of the given roleIds, via user-service's existing
 * GET /api/roles/users/by-role?roleIds=a,b,c (role.routes.js). Not called from anywhere yet
 * in this slice - kept ready for Resolved-By/Owner picker lookups and the recipient
 * resolution communication-service needs for the IR referral/outcome email triggers (a later
 * slice, see the plan §3.5).
 */
async function getUsersByRoleIds(roleIds, { req, tenantId } = {}) {
  const ids = (Array.isArray(roleIds) ? roleIds : [roleIds]).filter(Boolean);
  if (ids.length === 0) return {};
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(`${base}/api/roles/users/by-role`, {
      params: { roleIds: ids.join(",") },
      headers: buildHeaders(req, tenantId),
      timeout: 15000,
      validateStatus: (status) => status < 500,
    });
    if (response.status >= 400) return {};
    return response.data?.data || {};
  } catch (error) {
    console.error("[userService.client] getUsersByRoleIds failed:", error.message);
    return {};
  }
}

module.exports = {
  buildHeaders,
  getUsersByRoleIds,
};

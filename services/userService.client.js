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
    "x-correlation-id",
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

const USER_LOOKUP_CHUNK = 500;

// Display-name enrichment is non-critical: a slow or failing user-service must not hold the
// issue response for long. Bounded per call (default 3 s).
const NAME_LOOKUP_TIMEOUT_MS = Number(process.env.ISSUE_NAME_LOOKUP_TIMEOUT_MS) || 3000;

/**
 * Id -> { _id, fullName } for CRM/portal users referenced on issues (createdBy, owner.userId,
 * resolvedByUserId, ...), via user-service's POST /api/users/lookup. That endpoint trusts only
 * the caller's verified user JWT (the forwarded Authorization header), from which it takes the
 * tenant and checks issues:read - forwarded x-user-* headers are ignored there. Chunked at the
 * endpoint's 500-id cap. Best-effort: [] on error/timeout, so callers keep the raw ids.
 */
async function lookupUserNames(userIds, { req, tenantId } = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter(Boolean).map(String))];
  if (ids.length === 0) return [];
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const results = [];
  for (let i = 0; i < ids.length; i += USER_LOOKUP_CHUNK) {
    try {
      const response = await axios.post(
        `${base}/api/users/lookup`,
        { ids: ids.slice(i, i + USER_LOOKUP_CHUNK) },
        { headers: buildHeaders(req, tenantId), timeout: NAME_LOOKUP_TIMEOUT_MS, validateStatus: (status) => status < 500 },
      );
      if (response.status < 400 && Array.isArray(response.data?.data)) {
        results.push(...response.data.data);
      }
    } catch (error) {
      console.error("[userService.client] lookupUserNames failed", { code: error.code || null, status: error.response?.status || null });
    }
  }
  return results;
}

module.exports = {
  buildHeaders,
  getUsersByRoleIds,
  lookupUserNames,
  NAME_LOOKUP_TIMEOUT_MS,
};

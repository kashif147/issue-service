const axios = require("axios");

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL || "http://profile-service:4002";

// profile-service's Group feature (see the plan §2) is a separate, parallel workstream and
// may not exist yet - this client is correct to call regardless, it just won't succeed at
// runtime until that lands (404/ECONNREFUSED are both handled the same way below).
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

/** List groups, e.g. for the issue Group-linking control (search/drill-down by criteria). */
async function listGroups(query = {}, { req, tenantId } = {}) {
  const base = PROFILE_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(`${base}/api/groups`, {
      params: query,
      headers: buildHeaders(req, tenantId),
      timeout: 15000,
      validateStatus: (status) => status < 500,
    });
    if (response.status >= 400) return [];
    return response.data?.data || [];
  } catch (error) {
    console.error("[groupService.client] listGroups failed:", error.message);
    return [];
  }
}

/**
 * Resolved members for a Group - STATIC returns the saved staticMemberIds, DYNAMIC is
 * re-evaluated live against the criteria on every call (profile-service's responsibility,
 * not cached here).
 */
async function getGroupMembers(groupId, { req, tenantId } = {}) {
  if (!groupId) return [];
  const base = PROFILE_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(`${base}/api/groups/${groupId}/members`, {
      headers: buildHeaders(req, tenantId),
      timeout: 15000,
      validateStatus: (status) => status < 500,
    });
    if (response.status >= 400) return [];
    return response.data?.data || [];
  } catch (error) {
    console.error("[groupService.client] getGroupMembers failed:", error.message);
    return [];
  }
}

module.exports = {
  buildHeaders,
  listGroups,
  getGroupMembers,
};

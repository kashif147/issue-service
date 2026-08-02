const axios = require("axios");

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL || "http://profile-service:4002";

// Forwards the caller's own gateway-verified headers per the cross-service-auth skill -
// never a shared API key. See buildHeaders() in profile-service's own
// subscription.service.client.js for the pattern this copies.
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

/** Member search, for linking a member to an issue (name/membership no/dob/email/etc). */
async function searchProfiles(query, { req, tenantId } = {}) {
  const base = PROFILE_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(`${base}/api/profile/search`, {
      params: { q: query },
      headers: buildHeaders(req, tenantId),
      timeout: 15000,
      validateStatus: (status) => status < 500,
    });
    if (response.status >= 400) return [];
    return response.data?.data || [];
  } catch (error) {
    console.error("[profileService.client] searchProfiles failed:", error.message);
    return [];
  }
}

/** Single profile by id, including professionalDetails (workLocation/branch/region/grade). */
async function getProfileById(profileId, { req, tenantId } = {}) {
  if (!profileId) return null;
  const base = PROFILE_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(`${base}/api/profile/${profileId}`, {
      headers: buildHeaders(req, tenantId),
      timeout: 15000,
      validateStatus: (status) => status < 500,
    });
    if (response.status >= 400) return null;
    return response.data?.data || null;
  } catch (error) {
    console.error("[profileService.client] getProfileById failed:", error.message);
    return null;
  }
}

/** Batch fetch, e.g. hydrating an issue grid's memberIds into display names/membership nos. */
async function getProfilesBatch(profileIds, { req, tenantId } = {}) {
  if (!Array.isArray(profileIds) || profileIds.length === 0) return [];
  const base = PROFILE_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.post(
      `${base}/api/profile/batch`,
      { profileIds },
      { headers: buildHeaders(req, tenantId), timeout: 15000, validateStatus: (status) => status < 500 },
    );
    if (response.status >= 400) return [];
    return response.data?.data || [];
  } catch (error) {
    console.error("[profileService.client] getProfilesBatch failed:", error.message);
    return [];
  }
}

/**
 * professionalDetails.workLocation for a given profile - the first hop of IRO resolution
 * (services/iroResolution.service.js, owned by a separate parallel workstream, resolves the
 * second hop via services/lookup.service.client.js once that lands). Exposed here since it's
 * plain profile data, not lookup data.
 */
async function getProfessionalDetails(profileId, { req, tenantId } = {}) {
  const profile = await getProfileById(profileId, { req, tenantId });
  return profile?.professionalDetails || null;
}

module.exports = {
  buildHeaders,
  searchProfiles,
  getProfileById,
  getProfilesBatch,
  getProfessionalDetails,
};

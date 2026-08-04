const axios = require("axios");
const mongoose = require("mongoose");

// Generic client for user-service's Lookup/LookupType system. Copies the
// resolve-type-by-code -> cache -> fetch by-type/:id/hierarchy -> filter client-side
// pattern from profile-service/services/lookup.service.client.js (there is no server-side
// search param on user-service's Lookup API - confirmed by reading its controller). Used
// for two things (plan §1.1):
//   - Issue Designations dropdown (LookupType code "ISSUEDESG") - no local model, this is
//     the only source of truth.
//   - IRO resolution's second hop (LookupType code "WORKLOC" -> Lookup.officer), via
//     services/iroResolution.service.js.

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL || process.env.POLICY_SERVICE_URL || "http://user-service:5001";

const LOOKUP_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;
const lookupTypeIdCache = new Map(); // code -> { id, expiry }

const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

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

// The default (non-"simple") by-type/hierarchy response nests each result as
// {lookup, hierarchy} - unwrap to the flat lookup shape (incl. officer, DisplayName, code).
function unwrapLookupPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.lookup && typeof payload.lookup === "object") {
    return { ...payload.lookup };
  }
  return payload;
}

async function getLookupTypeIdByCode(code, headers) {
  const cached = lookupTypeIdCache.get(code);
  if (cached && Date.now() < cached.expiry) {
    return cached.id;
  }

  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(`${base}/api/lookuptype`, {
    headers,
    timeout: 8000,
    validateStatus: (status) => status < 500,
  });

  if (response.status < 200 || response.status >= 300) return null;

  const types = Array.isArray(response.data) ? response.data : response.data?.data || [];
  const match = types.find((type) => type?.code === code);
  if (!match?._id) return null;

  lookupTypeIdCache.set(code, { id: String(match._id), expiry: Date.now() + LOOKUP_TYPE_CACHE_TTL_MS });
  return String(match._id);
}

async function fetchLookupsByTypeCode(code, headers) {
  const typeId = await getLookupTypeIdByCode(code, headers);
  if (!typeId) return [];

  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(`${base}/api/lookup/by-type/${typeId}/hierarchy`, {
    headers,
    timeout: 15000,
    validateStatus: (status) => status < 500,
  });

  if (response.status < 200 || response.status >= 300) return [];

  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  return results.map(unwrapLookupPayload);
}

async function fetchLookupById(id, headers) {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.get(`${base}/api/lookup/${id}`, {
    headers,
    timeout: 8000,
    validateStatus: (status) => status < 500,
  });
  if (response.status < 200 || response.status >= 300) return null;
  return unwrapLookupPayload(response.data?.data ?? response.data);
}

/**
 * Resolve a Work Location by its stored label (Profile.professionalDetails.workLocation is
 * a plain String, not an ObjectId ref) or by id if it happens to already be one. Mirrors
 * profile-service's own findWorkLocationLookup/findWorkLocationLookupByName exactly, since
 * this is the same first-hop match every other service doing this resolution already does.
 */
async function findWorkLocationLookup(workLocationKey, { req, tenantId } = {}) {
  const key = String(workLocationKey || "").trim();
  if (!key || normalizeKey(key) === "other") return null;

  const headers = buildHeaders(req, tenantId);

  if (mongoose.Types.ObjectId.isValid(key) && key.length === 24) {
    const byId = await fetchLookupById(key, headers);
    if (byId) return byId;
  }

  const workLocations = await fetchLookupsByTypeCode("WORKLOC", headers);
  const normalizedKey = normalizeKey(key);
  return (
    workLocations.find((lookup) => {
      const candidates = [lookup?._id, lookup?.code, lookup?.lookupname, lookup?.DisplayName]
        .filter((value) => value != null && String(value).trim() !== "")
        .map(normalizeKey);
      return candidates.includes(normalizedKey);
    }) || null
  );
}

/**
 * Search Issue Designations (LookupType code "ISSUEDESG") by displayname/code -
 * client-side filter, since user-service's Lookup API has no server-side search param.
 * Returns each match's group ancestor (ISSUEGRP, Individual/Group-Regional/National) via
 * the hierarchy the by-type/hierarchy endpoint already returns per-item.
 */
async function searchIssueDesignations(query, { req, tenantId } = {}) {
  const headers = buildHeaders(req, tenantId);
  const designations = await fetchLookupsByTypeCode("ISSUEDESG", headers);

  const needle = normalizeKey(query);
  const filtered = needle
    ? designations.filter((lookup) => {
        const haystack = [lookup?.code, lookup?.lookupname, lookup?.DisplayName]
          .filter(Boolean)
          .map(normalizeKey);
        return haystack.some((value) => value.includes(needle));
      })
    : designations;

  return filtered.map((lookup) => ({
    id: lookup?._id || null,
    code: lookup?.code || null,
    displayName: lookup?.DisplayName || lookup?.lookupname || null,
    group: lookup?.Parentlookup || null,
    groupId: lookup?.Parentlookupid || null,
  }));
}

/**
 * Issue Type options (LookupType code "ISST") for the Create/Edit Cases dropdown - replaces
 * the formerly-hardcoded ISSUE_TYPES constant. Flat list, no parent filtering.
 */
async function fetchIssueTypes({ req, tenantId } = {}) {
  const headers = buildHeaders(req, tenantId);
  const types = await fetchLookupsByTypeCode("ISST", headers);
  return types.map((lookup) => ({
    id: lookup?._id || null,
    code: lookup?.code || null,
    displayName: lookup?.DisplayName || lookup?.lookupname || null,
  }));
}

/**
 * Issue Status options (LookupType code "ISSUSTATUS") for a given Issue Type - each status
 * Lookup is a child of its Issue Type's Lookup value (Parentlookupid), same hierarchy
 * mechanism as WORKLOC's Region -> Branch -> Work Location chain. issueTypeCode is the
 * Issue Type's own Lookup.code (e.g. "COMPLAINT", "DP"), not the LookupType code.
 */
async function fetchIssueStatuses(issueTypeCode, { req, tenantId } = {}) {
  const code = String(issueTypeCode || "").trim();
  if (!code) return [];

  const headers = buildHeaders(req, tenantId);
  const [issueTypes, statuses] = await Promise.all([
    fetchLookupsByTypeCode("ISST", headers),
    fetchLookupsByTypeCode("ISSUSTATUS", headers),
  ]);

  const matchedType = issueTypes.find((lookup) => normalizeKey(lookup?.code) === normalizeKey(code));
  if (!matchedType?._id) return [];

  const parentId = normalizeKey(matchedType._id);
  return statuses
    .filter((lookup) => normalizeKey(lookup?.Parentlookupid) === parentId)
    .map((lookup) => ({
      id: lookup?._id || null,
      code: lookup?.code || null,
      displayName: lookup?.DisplayName || lookup?.lookupname || null,
    }));
}

module.exports = {
  buildHeaders,
  fetchLookupsByTypeCode,
  findWorkLocationLookup,
  searchIssueDesignations,
  fetchIssueTypes,
  fetchIssueStatuses,
};

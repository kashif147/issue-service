const { AppError } = require("../errors/AppError");
const lookupServiceClient = require("../services/lookup.service.client");

// Thin read-through proxies over user-service's Lookup/LookupType system - no local storage,
// same pattern as controllers/issueDesignation.controller.js. Replace the formerly-hardcoded
// ISSUE_TYPES/ISSUE_STATUSES constants for the Create/Edit Cases dropdowns.

async function listIssueTypes(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const issueTypes = await lookupServiceClient.fetchIssueTypes({ req, tenantId });
    return res.status(200).json({ success: true, data: issueTypes });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch issue types"));
  }
}

// Issue Status options are scoped to a given Issue Type (Lookup hierarchy: each status is a
// child of its Issue Type's Lookup value) - issueType query param is required.
async function listIssueStatuses(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { issueType } = req.query;
    if (!issueType) {
      return next(AppError.badRequest("issueType query param is required"));
    }
    const issueStatuses = await lookupServiceClient.fetchIssueStatuses(issueType, { req, tenantId });
    return res.status(200).json({ success: true, data: issueStatuses });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch issue statuses"));
  }
}

async function listOrigins(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const origins = await lookupServiceClient.fetchOrigins({ req, tenantId });
    return res.status(200).json({ success: true, data: origins });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch origins"));
  }
}

async function listIssueSources(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const issueSources = await lookupServiceClient.fetchIssueSources({ req, tenantId });
    return res.status(200).json({ success: true, data: issueSources });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch issue sources"));
  }
}

// Combines the 3 flat, non-dependent dropdown lookups (Issue Type, Origin, Issue Source)
// into a single round trip - the Create/Edit Cases forms were firing 3 near-simultaneous
// requests for these on mount, which was enough to trip the gateway's per-client
// limit_req burst allowance (nginx api_rate zone, default.conf) on ordinary page loads.
// Issue Status stays a separate endpoint since it's the one that actually depends on the
// selected Issue Type and can't be prefetched up front.
async function listDropdownLookups(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const [issueTypes, origins, issueSources] = await Promise.all([
      lookupServiceClient.fetchIssueTypes({ req, tenantId }),
      lookupServiceClient.fetchOrigins({ req, tenantId }),
      lookupServiceClient.fetchIssueSources({ req, tenantId }),
    ]);
    return res.status(200).json({ success: true, data: { issueTypes, origins, issueSources } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch dropdown lookups"));
  }
}

module.exports = {
  listIssueTypes,
  listIssueStatuses,
  listOrigins,
  listIssueSources,
  listDropdownLookups,
};

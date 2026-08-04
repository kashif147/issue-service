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

// Combines the flat, non-dependent dropdown lookups (Issue Type, Origin, Issue Source,
// Priority, Complaint Type) into a single round trip - the Create/Edit Cases forms were
// firing these as separate near-simultaneous requests on mount, which was enough to trip
// the gateway's per-client limit_req burst allowance (nginx api_rate zone, default.conf) on
// ordinary page loads. Complaint Type is always scoped to the COMPLAINT Issue Type (fixed,
// not caller-supplied), so it belongs here rather than as its own endpoint. Issue Status
// stays a separate endpoint since it depends on whichever Issue Type the user picks and
// can't be prefetched up front.
async function listDropdownLookups(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const [issueTypes, origins, issueSources, priorities, complaintTypes] = await Promise.all([
      lookupServiceClient.fetchIssueTypes({ req, tenantId }),
      lookupServiceClient.fetchOrigins({ req, tenantId }),
      lookupServiceClient.fetchIssueSources({ req, tenantId }),
      lookupServiceClient.fetchPriorities({ req, tenantId }),
      lookupServiceClient.fetchComplaintTypes({ req, tenantId }),
    ]);
    return res.status(200).json({
      success: true,
      data: { issueTypes, origins, issueSources, priorities, complaintTypes },
    });
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

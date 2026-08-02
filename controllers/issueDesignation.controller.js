const { AppError } = require("../errors/AppError");
const lookupServiceClient = require("../services/lookup.service.client");

// Thin read-through proxy over user-service's Lookup/LookupType system - no local storage
// (plan §1.1/§1.2: "GET /issue-designations?search= ... a thin read-through proxy over
// user-service's Lookup API, no local storage").
async function search(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { search: query } = req.query;
    const designations = await lookupServiceClient.searchIssueDesignations(query, { req, tenantId });
    return res.status(200).json({ success: true, data: designations });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to search issue designations"));
  }
}

module.exports = { search };

const express = require("express");
const router = express.Router();
const issueLookupController = require("../controllers/issueLookup.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// Dropdown metadata for the Create/Edit Cases forms - gated on the base "issues" resource,
// same floor-level check as GET /issues (routes/issue.routes.js), since every team that can
// read/write any issue needs these options regardless of which team-specific resource they hold.
// Combined endpoint - prefer this over the 3 individual ones below when fetching all of
// Issue Type/Origin/Issue Source together (see the controller's comment for why).
router.get(
  "/issue-dropdown-lookups",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueLookupController.listDropdownLookups,
);
router.get(
  "/issue-types",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueLookupController.listIssueTypes,
);
router.get(
  "/issue-statuses",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueLookupController.listIssueStatuses,
);
router.get(
  "/origins",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueLookupController.listOrigins,
);
router.get(
  "/issue-sources",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueLookupController.listIssueSources,
);

module.exports = router;

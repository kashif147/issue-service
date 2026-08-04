const express = require("express");
const router = express.Router();
const issueLookupController = require("../controllers/issueLookup.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// Dropdown metadata for the Create/Edit Cases forms - gated on the base "issues" resource,
// same floor-level check as GET /issues (routes/issue.routes.js), since every team that can
// read/write any issue needs these options regardless of which team-specific resource they hold.
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

module.exports = router;

const express = require("express");
const router = express.Router();
const issueController = require("../controllers/issue.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

router.get("/", defaultPolicyMiddleware.requirePermission("issues", "read"), issueController.listIssues);
router.get("/:id", defaultPolicyMiddleware.requirePermission("issues", "read"), issueController.getIssueById);
router.post("/", defaultPolicyMiddleware.requirePermission("issues", "write"), issueController.createIssue);

// The floor here is the base "issues" resource - the real, document-specific check
// (issues-<team>:write) happens inside the controller, since the required team resource
// depends on the loaded issue's issueType and can't be known at route-registration time
// (plan §1.2).
router.put("/:id", defaultPolicyMiddleware.requirePermission("issues", "write"), issueController.updateIssue);
router.put(
  "/:id/status",
  defaultPolicyMiddleware.requirePermission("issues", "write"),
  issueController.updateIssueStatus,
);
router.delete(
  "/:id",
  defaultPolicyMiddleware.requirePermission("issues", "write"),
  issueController.softDeleteIssue,
);

module.exports = router;

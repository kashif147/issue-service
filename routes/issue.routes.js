const express = require("express");
const router = express.Router();
const issueController = require("../controllers/issue.controller.js");
const issuePortalController = require("../controllers/issuePortal.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { upload } = require("../middlewares/upload.mw.js");

router.get("/", defaultPolicyMiddleware.requirePermission("issues", "read"), issueController.listIssues);

// Must be registered before "/:id" - Express matches routes in registration order, and
// "/:id" would otherwise swallow "/search" as an :id value of "search".
router.get(
  "/search",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueController.searchIssues,
);

// Member-portal self-service surface (controllers/issuePortal.controller.js) - a fully
// separate controller from the CRM routes below, gated by the platform's existing generic
// requirePermission("portal", "read"/"write") (same one profile-service's
// paymentForm.routes.js portalRouter uses), not the CRM-only "issues"/"issues-<team>"
// resources. MEMBER role already holds portal:read/portal:write, so no new RBAC grant is
// needed. Mounted before "/:id" for the same Express route-registration-order reason
// "/search" is above - "/portal/mine" et al must not be swallowed, and a bare GET
// "/portal" would otherwise be captured by "/:id" treating "portal" as an issue id.
const portalRead = defaultPolicyMiddleware.requirePermission("portal", "read");
const portalWrite = defaultPolicyMiddleware.requirePermission("portal", "write");
const portalRouter = express.Router();
portalRouter.get("/mine", portalRead, issuePortalController.portalListMyIssues);
portalRouter.post("/", portalWrite, issuePortalController.portalCreateIssue);
portalRouter.get("/:id", portalRead, issuePortalController.portalGetMyIssueById);
portalRouter.get(
  "/:id/activities",
  portalRead,
  issuePortalController.portalListMyIssueActivities,
);
portalRouter.post(
  "/:id/activities",
  portalWrite,
  upload.single("file"),
  issuePortalController.portalAddIssueComment,
);
// Edit/delete a member's own comment - never another author's, see
// issuePortalController.loadMyOwnComment's createdBy check. Editing is blocked once the
// issue is CLOSED (same as creating a new comment); deleting is not. Attachments aren't
// independently editable (no "replace this file" affordance anywhere in this service, CRM
// included) - portalRemoveAttachment below is the way to drop just one.
portalRouter.put(
  "/:id/activities/:activityId",
  portalWrite,
  issuePortalController.portalUpdateComment,
);
portalRouter.delete(
  "/:id/activities/:activityId",
  portalWrite,
  issuePortalController.portalDeleteComment,
);
// Removes one attachment (and actually deletes its blob, unlike the soft-deletes above)
// rather than the whole comment - no route-order concern vs. the ":activityId" delete
// above, the extra path segments make them unambiguous either way.
portalRouter.delete(
  "/:id/activities/:activityId/attachments/:index",
  portalWrite,
  issuePortalController.portalRemoveAttachment,
);
portalRouter.get(
  "/:id/activities/:activityId/attachments/:index/download",
  portalRead,
  issuePortalController.portalDownloadAttachment,
);
router.use("/portal", portalRouter);

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

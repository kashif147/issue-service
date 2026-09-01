const express = require("express");
const router = express.Router();
const issueActivityController = require("../controllers/issueActivity.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// Mounted at "/" (see routes/index.js) so this file owns both the /issues/:id/activities
// nested path and the flat /activities/:activityId path, exactly as listed in the plan
// (§1.2). Activities use the same team-resource read/write floor as their parent issue -
// the actual team check happens in the controller once the parent issue is loaded, same
// reasoning as issue.routes.js's PUT routes.
router.post(
  "/issues/:id/activities",
  defaultPolicyMiddleware.requirePermission("issues", "write"),
  issueActivityController.createActivity,
);
router.get(
  "/issues/:id/activities",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueActivityController.getActivities,
);
router.put(
  "/activities/:activityId",
  defaultPolicyMiddleware.requirePermission("issues", "write"),
  issueActivityController.updateActivity,
);
router.get(
  "/activities/:activityId/attachments/:index/download",
  defaultPolicyMiddleware.requirePermission("issues", "read"),
  issueActivityController.downloadAttachment,
);

module.exports = router;

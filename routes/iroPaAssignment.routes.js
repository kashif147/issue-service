const express = require("express");
const router = express.Router();
const iroPaAssignmentController = require("../controllers/iroPaAssignment.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

router.get("/", defaultPolicyMiddleware.requirePermission("issues", "read"), iroPaAssignmentController.list);
router.post("/", defaultPolicyMiddleware.requirePermission("issues", "write"), iroPaAssignmentController.create);
router.put("/:id", defaultPolicyMiddleware.requirePermission("issues", "write"), iroPaAssignmentController.update);
router.delete(
  "/:id",
  defaultPolicyMiddleware.requirePermission("issues", "write"),
  iroPaAssignmentController.remove,
);

module.exports = router;

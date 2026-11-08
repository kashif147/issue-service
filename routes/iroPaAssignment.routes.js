const express = require("express");
const router = express.Router();
const iroPaAssignmentController = require("../controllers/iroPaAssignment.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// PDP rollout P2 (Q1, owner decision 2026-11-08): IRO/PA assignments belong to the Industrial Relations
// team, so they are gated by the IR team resource alone - "issues-ir:read" to list, "issues-ir:write" to
// create / update / delete. The generic "issues:*" codes no longer open these routes (no IR team role holds
// them, and a role holding only issues:* - e.g. REO, MO - must not see or change the IR team's assignments).
// Tenant scope is unchanged: every controller query is bound to req.ctx.tenantId.
router.get("/", defaultPolicyMiddleware.requirePermission("issues-ir", "read"), iroPaAssignmentController.list);
router.post("/", defaultPolicyMiddleware.requirePermission("issues-ir", "write"), iroPaAssignmentController.create);
router.put("/:id", defaultPolicyMiddleware.requirePermission("issues-ir", "write"), iroPaAssignmentController.update);
router.delete("/:id", defaultPolicyMiddleware.requirePermission("issues-ir", "write"), iroPaAssignmentController.remove);

module.exports = router;

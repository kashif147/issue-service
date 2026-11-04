const express = require("express");
const router = express.Router();
const iroPaAssignmentController = require("../controllers/iroPaAssignment.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// PDP rollout P2 (Q1): IRO/PA assignments belong to the Industrial Relations team. Writes keep the
// generic "issues:write" floor AND require the IR team resource "issues-ir:write", so a role holding
// only issues:write (e.g. MO, which works COMPLAINT cases) can't change the IR team's assignments.
// Reads are unchanged (issues:read).
const issuesWrite = defaultPolicyMiddleware.requirePermission("issues", "write");
const irTeamWrite = defaultPolicyMiddleware.requirePermission("issues-ir", "write");

router.get("/", defaultPolicyMiddleware.requirePermission("issues", "read"), iroPaAssignmentController.list);
router.post("/", issuesWrite, irTeamWrite, iroPaAssignmentController.create);
router.put("/:id", issuesWrite, irTeamWrite, iroPaAssignmentController.update);
router.delete("/:id", issuesWrite, irTeamWrite, iroPaAssignmentController.remove);

module.exports = router;

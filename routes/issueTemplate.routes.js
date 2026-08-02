const express = require("express");
const router = express.Router();
const issueTemplateController = require("../controllers/issueTemplate.controller");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// Gated on the dedicated "issues-templates" resource (already-seeded, see
// backend/user-service/scripts/grant-issues-permissions-to-roles.js) - never a compound
// action string, per the plan's permission-string constraint (§0/§1.2).

// Create a new filter template
router.post(
  "/",
  defaultPolicyMiddleware.requirePermission("issues-templates", "write"),
  issueTemplateController.createTemplate,
);

// Get all filter templates for the current user
router.get(
  "/",
  defaultPolicyMiddleware.requirePermission("issues-templates", "read"),
  issueTemplateController.getUserTemplates,
);

// Get default template for the current user
router.get(
  "/default",
  defaultPolicyMiddleware.requirePermission("issues-templates", "read"),
  issueTemplateController.getDefaultTemplate,
);

// Get a specific template by ID
router.get(
  "/:templateId",
  defaultPolicyMiddleware.requirePermission("issues-templates", "read"),
  issueTemplateController.getTemplateById,
);

// Update a filter template
router.put(
  "/:templateId",
  defaultPolicyMiddleware.requirePermission("issues-templates", "write"),
  issueTemplateController.updateTemplate,
);

// Delete a filter template
router.delete(
  "/:templateId",
  defaultPolicyMiddleware.requirePermission("issues-templates", "write"),
  issueTemplateController.deleteTemplate,
);

module.exports = router;

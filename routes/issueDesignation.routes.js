const express = require("express");
const router = express.Router();
const issueDesignationController = require("../controllers/issueDesignation.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// IR-specific lookup - gated on the issues-ir resource per the plan's permission table.
router.get(
  "/",
  defaultPolicyMiddleware.requirePermission("issues-ir", "read"),
  issueDesignationController.search,
);

module.exports = router;

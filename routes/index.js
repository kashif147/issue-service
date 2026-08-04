const router = require("express").Router();

router.use("/issues", require("./issue.routes"));
// issueActivity.routes.js owns both /issues/:id/activities and /activities/:activityId, so
// it's mounted at the router root rather than under a single fixed prefix.
router.use("/", require("./issueActivity.routes"));
router.use("/iro-pa-assignments", require("./iroPaAssignment.routes"));
router.use("/issue-designations", require("./issueDesignation.routes"));
router.use("/", require("./issueLookup.routes"));
router.use("/templates", require("./issueTemplate.routes"));

module.exports = router;

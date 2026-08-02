const Issue = require("../models/issue.model");
const Activity = require("../models/activity.model");
const { AppError } = require("../errors/AppError");
const issueService = require("../services/issue.service");

/** The parent Issue, subject to the same team-visibility + complaint-hide filters as issue.controller.js. */
async function loadParentIssue(req, issueId) {
  const { tenantId, userId } = req.ctx;
  const allowedTypes = issueService.getAllowedIssueTypes(req);
  const filter = issueService.withComplaintHideFilter(
    { _id: issueId, tenantId, issueType: { $in: allowedTypes }, "meta.deleted": { $ne: true } },
    userId,
  );
  return Issue.findOne(filter);
}

function hasTeamReadPermission(req, issueType) {
  const resource = issueService.teamResourceForIssueType(issueType);
  if (!resource) return false;
  const permissions = req.ctx?.permissions || [];
  return permissions.includes(`${resource}:read`);
}

async function createActivity(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const issue = await loadParentIssue(req, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to log activities for issues of this type"));
    }

    const body = req.body || {};
    if (!body.activityType) {
      return next(AppError.badRequest("activityType is required"));
    }

    const activity = await Activity.create({
      tenantId,
      issueId: issue._id,
      activityType: body.activityType,
      subject: body.subject ?? null,
      body: body.body ?? null,
      interactionDate: body.interactionDate || new Date(),
      createdBy: userId,
      pertinentToFileReview: !!body.pertinentToFileReview,
      // Defaults to true (checked) per the plan's "default checked" activity-log form spec -
      // only an explicit false opts out.
      sendNotification: body.sendNotification !== false,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
    });

    return res.status(201).json({ success: true, data: activity });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError(error.message || "Failed to create activity"));
  }
}

async function getActivities(req, res, next) {
  try {
    const issue = await loadParentIssue(req, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!hasTeamReadPermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to view activities for issues of this type"));
    }

    const filter = { tenantId: req.ctx.tenantId, issueId: issue._id };
    if (req.query.pertinentToFileReview !== undefined) {
      filter.pertinentToFileReview = req.query.pertinentToFileReview === "true";
    }

    const activities = await Activity.find(filter).sort({ interactionDate: -1 });
    return res.status(200).json({ success: true, data: activities });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list activities"));
  }
}

async function updateActivity(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const activity = await Activity.findOne({ _id: req.params.activityId, tenantId });
    if (!activity) return next(AppError.notFound("Activity not found"));

    // Team-visibility/complaint-hide filtering runs against the *parent issue*, not the
    // activity itself - an activity attached to an issue this caller can't see must also
    // resolve to "not found", never leaking the activity's existence.
    const issue = await loadParentIssue(req, activity.issueId);
    if (!issue) return next(AppError.notFound("Activity not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(
        AppError.forbidden("Not permitted to update activities for issues of this type"),
      );
    }

    const body = { ...(req.body || {}) };
    for (const protectedField of ["_id", "tenantId", "issueId", "createdBy"]) {
      delete body[protectedField];
    }
    Object.assign(activity, body);
    await activity.save();

    return res.status(200).json({ success: true, data: activity });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.name === "CastError") return next(AppError.notFound("Activity not found"));
    return next(AppError.internalServerError(error.message || "Failed to update activity"));
  }
}

module.exports = {
  createActivity,
  getActivities,
  updateActivity,
};

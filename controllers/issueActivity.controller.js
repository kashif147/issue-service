const Issue = require("../models/issue.model");
const Activity = require("../models/activity.model");
const HistoryEntry = require("../models/historyEntry.model");
const { AppError } = require("../errors/AppError");
const issueService = require("../services/issue.service");
const { recordHistory, summarizeObjectDiff } = require("../services/history.service");
const {
  uploadToBlob,
  getDownloadSasUrl,
  buildIssueAttachmentBlobPath,
} = require("../services/azure.blob.service");

/** Short, human-readable label for an Activity in a history summary - "a NOTE" / "a NOTE
 * (Called the member)" when it has a subject, never the full rich-text body. */
function activityLabel(activity) {
  return activity.subject
    ? `a ${activity.activityType} activity ("${activity.subject}")`
    : `a ${activity.activityType} activity`;
}

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
  return issueService.hasPermission(permissions, `${resource}:read`);
}

/**
 * The frontend's activity body is ReactQuill rich text - its "empty" state is HTML like
 * "<p><br></p>", not "" - so a plain truthiness/trim check on the raw string would let an
 * empty-looking activity through. Strips tags before checking for real content, mirroring
 * CasesDetails.js's own stripHtml() used client-side for the same reason.
 */
function hasMeaningfulText(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim().length > 0;
}

/** Same rule the portal side already enforces (controllers/issuePortal.controller.js's
 * portalAddIssueComment) - a closed issue is done, so no new activity/attachment should be
 * addable to it from either side of the app. */
function assertIssueNotClosed(issue) {
  if (issue.issueStatus === "CLOSED") {
    throw AppError.badRequest("Cannot add an activity to a closed issue");
  }
}

async function createActivity(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const issue = await loadParentIssue(req, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to log activities for issues of this type"));
    }

    assertIssueNotClosed(issue);

    const body = req.body || {};
    if (!body.activityType) {
      return next(AppError.badRequest("activityType is required"));
    }
    if (!hasMeaningfulText(body.body)) {
      return next(AppError.badRequest("Activity text is required"));
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
      // Defaults to false - only an explicit true surfaces this internal-note-by-default
      // activity to the member on the portal (controllers/issuePortal.controller.js's
      // portalListMyIssueActivities), e.g. when CRM is replying to a member's comment.
      visibleToMember: !!body.visibleToMember,
    });

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: "CREATED",
      summary: `Logged ${activityLabel(activity)}`,
      actorId: userId,
      actorEmail: req.user?.email || req.headers["x-user-email"] || null,
    });

    return res.status(201).json({ success: true, data: activity });
  } catch (error) {
    if (error instanceof AppError) return next(error);
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

    const filter = { tenantId: req.ctx.tenantId, issueId: issue._id, "meta.deleted": { $ne: true } };
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
    // Only enforced when the caller is actually touching body - an edit that only flips
    // e.g. visibleToMember shouldn't be blocked by this.
    if (Object.prototype.hasOwnProperty.call(body, "body") && !hasMeaningfulText(body.body)) {
      return next(AppError.badRequest("Activity text is required"));
    }

    const before = activity.toObject();
    Object.assign(activity, body);
    await activity.save();
    const after = activity.toObject();

    const diff = summarizeObjectDiff(before, after);
    if (diff) {
      recordHistory({
        tenantId,
        issueId: issue._id,
        entityType: "ACTIVITY",
        entityId: activity._id,
        action: "UPDATED",
        summary: `Edited ${activityLabel(activity)}: ${diff.summary}`,
        changedFields: diff.changedFields,
        actorId: req.ctx.userId,
        actorEmail: req.user?.email || req.headers["x-user-email"] || null,
      });
    }

    return res.status(200).json({ success: true, data: activity });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.name === "CastError") return next(AppError.notFound("Activity not found"));
    return next(AppError.internalServerError(error.message || "Failed to update activity"));
  }
}

/** Soft-delete (see models/activity.model.js's meta field doc comment) - content is
 * preserved, not wiped, so the DELETED history entry can show what was actually removed.
 * Same team-write-permission floor as updateActivity; deleting on a closed issue is still
 * allowed (matches updateActivity's existing "editing an old note is fine" stance - only
 * *new* activities/attachments are blocked on a closed issue, see assertIssueNotClosed's
 * callers). */
async function deleteActivity(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const activity = await Activity.findOne({
      _id: req.params.activityId,
      tenantId,
      "meta.deleted": { $ne: true },
    });
    if (!activity) return next(AppError.notFound("Activity not found"));

    const issue = await loadParentIssue(req, activity.issueId);
    if (!issue) return next(AppError.notFound("Activity not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(
        AppError.forbidden("Not permitted to delete activities for issues of this type"),
      );
    }

    activity.meta = { deleted: true, deletedAt: new Date(), deletedBy: userId };
    await activity.save();

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: "DELETED",
      summary: `Deleted ${activityLabel(activity)}`,
      actorId: userId,
      actorEmail: req.user?.email || req.headers["x-user-email"] || null,
    });

    return res.status(200).json({ success: true, data: { _id: activity._id, deleted: true } });
  } catch (error) {
    if (error.name === "CastError") return next(AppError.notFound("Activity not found"));
    return next(AppError.internalServerError(error.message || "Failed to delete activity"));
  }
}

/** CRM-side counterpart to controllers/issuePortal.controller.js#portalDownloadAttachment -
 * lets a team member with read access to the parent issue download a file a member
 * uploaded via the portal (or that CRM itself attached to an activity). */
async function downloadAttachment(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const activity = await Activity.findOne({
      _id: req.params.activityId,
      tenantId,
      "meta.deleted": { $ne: true },
    });
    if (!activity) return next(AppError.notFound("Attachment not found"));

    const issue = await loadParentIssue(req, activity.issueId);
    if (!issue) return next(AppError.notFound("Attachment not found"));

    if (!hasTeamReadPermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to view activities for issues of this type"));
    }

    const index = Number(req.params.index);
    const attachment = Array.isArray(activity.attachments) ? activity.attachments[index] : null;
    if (!attachment?.blobPath) return next(AppError.notFound("Attachment not found"));

    const url = getDownloadSasUrl(attachment.blobPath, 15);
    if (!url) return next(AppError.serviceUnavailable("Attachment storage is not configured"));

    // JSON, not res.redirect() - this route sits behind requirePermission (needs the
    // caller's JWT in an Authorization header), which a plain browser navigation/<a href>
    // following a 302 wouldn't send. The frontend fetches this via an authenticated axios
    // call, then opens the returned (self-authenticating, short-lived) SAS url directly -
    // that second hop needs no Authorization header of its own.
    return res.status(200).json({
      success: true,
      data: { url, filename: attachment.filename, contentType: attachment.contentType },
    });
  } catch (error) {
    if (error.name === "CastError") return next(AppError.notFound("Attachment not found"));
    return next(AppError.internalServerError(error.message || "Failed to download attachment"));
  }
}

/**
 * CRM's "Attachments" panel (CasesDetails.js) is a flat list of documents on the issue, not
 * tied to a specific logged activity/comment - there's no separate Issue-level document
 * model though, so this stores the file the same way portalAddIssueComment does (an Activity
 * carrying just an attachment, no text) and lists across every activity's attachments
 * rather than adding a new schema. sendNotification defaults false here (unlike
 * createActivity's true) - a plain document upload isn't necessarily something the owner
 * needs pinged about the way a logged call/note is.
 */
async function uploadIssueAttachment(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const issue = await loadParentIssue(req, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to upload attachments for issues of this type"));
    }

    assertIssueNotClosed(issue);

    if (!req.file) {
      return next(AppError.badRequest("A file is required"));
    }

    const blobPath = buildIssueAttachmentBlobPath(tenantId, issue._id, req.file.originalname);
    await uploadToBlob(blobPath, req.file.buffer, req.file.mimetype, req.file.originalname);

    const activity = await Activity.create({
      tenantId,
      issueId: issue._id,
      activityType: "NOTE",
      body: null,
      createdBy: userId,
      sendNotification: false,
      visibleToMember: false,
      attachments: [
        {
          filename: req.file.originalname,
          blobPath,
          contentType: req.file.mimetype,
          size: req.file.size,
        },
      ],
    });

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: "CREATED",
      summary: `Uploaded an attachment: ${req.file.originalname}`,
      actorId: userId,
      actorEmail: req.user?.email || req.headers["x-user-email"] || null,
    });

    return res.status(201).json({
      success: true,
      data: {
        activityId: activity._id,
        index: 0,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: activity.createdAt,
        uploadedBy: userId,
      },
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "ValidationError") return next(AppError.badRequest(error.message));
    return next(AppError.internalServerError(error.message || "Failed to upload attachment"));
  }
}

/** Flattens every activity's attachments on this issue into one list, newest activity
 * first - the data source for CRM's "Attachments" panel (which previously rendered two
 * hardcoded mock files with no backend behind them at all). */
async function listIssueAttachments(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const issue = await loadParentIssue(req, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!hasTeamReadPermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to view attachments for issues of this type"));
    }

    const activities = await Activity.find({
      tenantId,
      issueId: issue._id,
      "meta.deleted": { $ne: true },
      "attachments.0": { $exists: true },
    }).sort({ createdAt: -1 });

    const attachments = [];
    activities.forEach((activity) => {
      (activity.attachments || []).forEach((attachment, index) => {
        attachments.push({
          activityId: activity._id,
          index,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          uploadedAt: activity.createdAt,
          uploadedBy: activity.createdBy,
        });
      });
    });

    return res.status(200).json({ success: true, data: attachments });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list attachments"));
  }
}

/** CRM Case Details "History" section - replaces what was previously a hardcoded single
 * mock entry with real HistoryEntry rows written by services/history.service.js#recordHistory
 * (called from this file and issue.controller.js/issuePortal.controller.js wherever an
 * Issue/Activity is created, updated, or deleted). */
async function listHistory(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const issue = await loadParentIssue(req, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!hasTeamReadPermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to view history for issues of this type"));
    }

    const history = await HistoryEntry.find({ tenantId, issueId: issue._id }).sort({
      createdAt: -1,
    });

    return res.status(200).json({ success: true, data: history });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list history"));
  }
}

module.exports = {
  createActivity,
  getActivities,
  updateActivity,
  deleteActivity,
  downloadAttachment,
  uploadIssueAttachment,
  listIssueAttachments,
  listHistory,
};

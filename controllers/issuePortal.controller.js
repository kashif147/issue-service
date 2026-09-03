const Issue = require("../models/issue.model");
const Complaint = require("../models/issue.complaint.model");
const Activity = require("../models/activity.model");
const { AppError } = require("../errors/AppError");
const issueService = require("../services/issue.service");
const profileServiceClient = require("../services/profileService.client");
const {
  uploadToBlob,
  getDownloadSasUrl,
  buildIssueAttachmentBlobPath,
  deleteBlob,
} = require("../services/azure.blob.service");
const { recordHistory } = require("../services/history.service");

// Member-portal issue creation/self-service - a deliberately separate controller from
// issue.controller.js/issueActivity.controller.js (CRM path), not a userType branch inside
// them, so the existing CRM create/list/activity flows stay byte-for-byte unchanged. A
// member's own-issue visibility here is "am I one of this issue's memberIds", never the
// CRM team-visibility RBAC (getAllowedIssueTypes/hasTeamWritePermission) those other
// controllers use - those two visibility models are unrelated and must not be conflated.
// Route-level gating is the platform's existing generic requirePermission("portal",
// "read"/"write") (routes/issue.routes.js's portalRouter) - MEMBER role already holds both,
// no new RBAC surface needed. Because that permission already scopes every route in this
// file to portal callers, handlers don't re-check req.user.userType - a caller reaching
// these functions without holding "portal:read"/"portal:write" is a policy-configuration
// problem, not something to defend against again here.

// Only these fields may be set by a portal caller on create - everything else (owner,
// issueStatus*, priority, resolution*, issueType, memberIds, createdViaPortal, tenantId,
// createdBy, ...) is silently dropped regardless of what's in the body. Deliberately NOT
// issue.controller.js's stripProtectedFields/PROTECTED_FIELDS, which is CRM-oriented and
// would let owner/priority/issueStatus through.
const PORTAL_COMPLAINT_ALLOWED_FIELDS = [
  "complaintType",
  "description",
  "availability",
  "dateReceived",
  "origin",
  "respondents",
  "serviceProvider",
  "externalAgency",
  "externalCaseRef",
];

function pickAllowedFields(body) {
  const picked = {};
  for (const field of PORTAL_COMPLAINT_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body || {}, field)) {
      picked[field] = body[field];
    }
  }
  return picked;
}

/** The caller's own resolved profile, or a 400 AppError if it can't be resolved. */
async function resolveMyProfileOrThrow(req, tenantId) {
  const my = await profileServiceClient.getMyProfile({ req, tenantId });
  if (!my?.profileId) {
    throw AppError.badRequest("Unable to resolve your member profile");
  }
  return my;
}

/**
 * A MOM complaint's related-member info, as free text only - deliberately NOT resolved or
 * auto-matched against profile-service here. Matching a submitted name to an actual member
 * profile is a judgment call (multiple members can share a name) that a CRM reviewer makes
 * manually, not something the system guesses on the member's behalf - CRM links the real
 * profile later via the existing PUT /issues/:id (memberIds isn't a protected field there),
 * the same way any other issue edit works. Until that manual link happens, a MOM issue's
 * memberIds holds only the submitter's own profile (length 1) - CRM can find
 * not-yet-linked MOM complaints via `complaintType === "MOM" && memberIds.length < 2`.
 *
 * Accepts either an explicit `respondents` array (the existing free-text
 * name/email/phone/relationship shape every complaint type already supports) or a plain
 * `relatedMember` string, normalized into `respondents[0].name` if `respondents` wasn't
 * also given. Throws a 400 if neither is present - the member must identify *someone*, even
 * if the system won't attempt to resolve who that is.
 */
function requireRelatedMemberDescription(body) {
  const hasRespondentName = Array.isArray(body.respondents) && body.respondents.some((r) => r?.name);
  const relatedMember = String(body.relatedMember || "").trim();

  if (!hasRespondentName && !relatedMember) {
    throw AppError.badRequest(
      "relatedMember (the name of the member this complaint concerns) is required when complaintType is MOM",
    );
  }

  if (hasRespondentName) return undefined;
  return [{ name: relatedMember, email: null, phone: null, relationship: null }];
}

/** Own-issue lookup, shared by every portal read/write handler below - 404, never 403, on
 * no match (matches this service's existing hidden-doc convention, e.g.
 * withComplaintHideFilter's doc comment in services/issue.service.js), so a member can never
 * confirm the existence of an issue that isn't theirs. */
async function loadMyIssue(tenantId, myProfileId, issueId) {
  return Issue.findOne({
    _id: issueId,
    tenantId,
    memberIds: myProfileId,
    "meta.deleted": { $ne: true },
  });
}

/**
 * Flattens every member-visible activity's attachments on this issue into one list - GET
 * /issues/portal/:id embeds this directly (rather than making the caller separately fetch
 * /activities and cross-reference) since attachments live on Activity documents, not the
 * Issue itself, and that split isn't obvious/convenient from a portal client. Same shape
 * CRM's listIssueAttachments (issueActivity.controller.js) returns, minus internal-only
 * activities (visibleToMember: false is excluded, matching portalListMyIssueActivities).
 */
async function fetchMyIssueAttachments(tenantId, issueId) {
  const activities = await Activity.find({
    tenantId,
    issueId,
    visibleToMember: true,
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
      });
    });
  });
  return attachments;
}

async function portalCreateIssue(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const body = req.body || {};

    if (!body.complaintType || !Complaint.COMPLAINT_TYPES.includes(body.complaintType)) {
      return next(
        AppError.badRequest(
          `complaintType must be one of ${Complaint.COMPLAINT_TYPES.join(", ")}`,
        ),
      );
    }

    const my = await resolveMyProfileOrThrow(req, tenantId);

    // MOM's related member is captured as free text only, never auto-matched to a profile
    // here - see requireRelatedMemberDescription's doc comment. memberIds stays just the
    // submitter's own profile until CRM manually links the actual related member.
    let derivedRespondents;
    if (body.complaintType === "MOM") {
      derivedRespondents = requireRelatedMemberDescription(body);
    }

    const issue = new Complaint({
      ...pickAllowedFields(body),
      ...(derivedRespondents ? { respondents: derivedRespondents } : {}),
      memberIds: [my.profileId],
      tenantId,
      createdBy: userId,
      createdOn: new Date(),
      // dateReceived is required on the base schema (CRM's create form always collects it
      // explicitly) - a portal member isn't asked to backdate their own submission, so
      // default to "now" unless they passed one.
      dateReceived: body.dateReceived || new Date(),
      issueType: "COMPLAINT",
      createdViaPortal: true,
      origin: body.origin || "PORTAL-O",
    });

    const userInitials = issueService.deriveInitialsFromEmail(req.user?.email);
    await issueService.prepareNewIssue(issue, { req, tenantId, userInitials });

    await issue.save();

    await issueService.publishIssueCreatedEvents(issue, { tenantId, userId, req });

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ISSUE",
      entityId: issue._id,
      action: "CREATED",
      summary: "Issue created via member portal",
      actorId: userId,
      actorEmail: req.user?.email || req.headers?.["x-user-email"] || null,
    });

    return res.status(201).json({ success: true, data: issue });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError(error.message || "Failed to create issue"));
  }
}

async function portalListMyIssues(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issues = await Issue.find({
      tenantId,
      memberIds: my.profileId,
      "meta.deleted": { $ne: true },
    }).sort({ createdOn: -1 });

    return res.status(200).json({ success: true, data: issues });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to list your issues"));
  }
}

async function portalGetMyIssueById(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    const attachments = await fetchMyIssueAttachments(tenantId, issue._id);

    return res.status(200).json({
      success: true,
      data: { ...issue.toObject(), attachments },
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to fetch issue"));
  }
}

async function portalListMyIssueActivities(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    const activities = await Activity.find({
      tenantId,
      issueId: issue._id,
      visibleToMember: true,
      "meta.deleted": { $ne: true },
    }).sort({ interactionDate: -1 });

    return res.status(200).json({ success: true, data: activities });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to list activities"));
  }
}

async function portalAddIssueComment(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (issue.issueStatus === "CLOSED") {
      return next(AppError.badRequest("Cannot add a comment to a closed issue"));
    }

    const commentBody = req.body?.body || null;
    if (!commentBody && !req.file) {
      return next(AppError.badRequest("A comment or an attachment is required"));
    }

    const attachments = [];
    if (req.file) {
      const blobPath = buildIssueAttachmentBlobPath(tenantId, issue._id, req.file.originalname);
      await uploadToBlob(blobPath, req.file.buffer, req.file.mimetype, req.file.originalname);
      attachments.push({
        filename: req.file.originalname,
        blobPath,
        contentType: req.file.mimetype,
        size: req.file.size,
      });
    }

    const activity = await Activity.create({
      tenantId,
      issueId: issue._id,
      activityType: "NOTE",
      body: commentBody,
      createdBy: userId,
      visibleToMember: true,
      sendNotification: true,
      attachments,
    });

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: "CREATED",
      summary: attachments.length > 0 ? "Member added a comment with an attachment" : "Member added a comment",
      actorId: userId,
      actorEmail: req.user?.email || req.headers?.["x-user-email"] || null,
    });

    return res.status(201).json({ success: true, data: activity });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to add comment"));
  }
}

async function portalDownloadAttachment(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    const activity = await Activity.findOne({
      _id: req.params.activityId,
      tenantId,
      issueId: issue._id,
      visibleToMember: true,
      "meta.deleted": { $ne: true },
    });
    if (!activity) return next(AppError.notFound("Attachment not found"));

    const index = Number(req.params.index);
    const attachment = Array.isArray(activity.attachments) ? activity.attachments[index] : null;
    if (!attachment?.blobPath) return next(AppError.notFound("Attachment not found"));

    const url = getDownloadSasUrl(attachment.blobPath, 15);
    if (!url) return next(AppError.serviceUnavailable("Attachment storage is not configured"));

    // JSON, not res.redirect() - see issueActivity.controller.js#downloadAttachment's
    // comment: this route needs an Authorization header the browser wouldn't send on a
    // plain redirect-follow.
    return res.status(200).json({
      success: true,
      data: { url, filename: attachment.filename, contentType: attachment.contentType },
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to download attachment"));
  }
}

/**
 * ReactQuill-style "empty" HTML (e.g. "<p><br></p>") is still truthy/non-blank as a raw
 * string - strip tags before checking for real content. Same check as
 * issueActivity.controller.js's hasMeaningfulText; duplicated locally rather than importing
 * from the CRM controller, since this file is deliberately kept independent of it.
 */
function hasMeaningfulText(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim().length > 0;
}

/**
 * Own-comment lookup shared by portalUpdateComment/portalDeleteComment - 404s (never 403s)
 * both when the activityId doesn't exist under this issue and when it exists but wasn't
 * created by this caller, so a member can't distinguish "not yours" from "doesn't exist"
 * (same not-found-not-forbidden convention loadMyIssue uses one level up).
 *
 * createdBy is compared against req.ctx.userId (the authenticated user, set on create by
 * portalAddIssueComment/portalUpdateComment - see there), not profileId - this is what
 * naturally excludes CRM-authored activities a team member flagged visibleToMember:true,
 * since those carry a CRM user's userId, never this member's.
 */
async function loadMyOwnComment(tenantId, userId, issueId, activityId) {
  return Activity.findOne({
    _id: activityId,
    tenantId,
    issueId,
    createdBy: userId,
    "meta.deleted": { $ne: true },
  });
}

/**
 * Edits the comment text of a member's own portal comment. Blocked once the issue is
 * CLOSED - same rule portalAddIssueComment already applies to *new* comments, extended here
 * to edits too, so a closed issue's activity trail is frozen either way.
 *
 * Only `body` is editable - an attachment already on the comment can't be swapped in place
 * (same as CRM: there's no "replace this file" affordance anywhere in this service).
 * portalRemoveAttachment is the way to drop an attachment from a comment.
 */
async function portalUpdateComment(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (issue.issueStatus === "CLOSED") {
      return next(AppError.badRequest("Cannot edit a comment on a closed issue"));
    }

    const activity = await loadMyOwnComment(tenantId, userId, issue._id, req.params.activityId);
    if (!activity) return next(AppError.notFound("Comment not found"));

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "body")) {
      return next(AppError.badRequest("body is required"));
    }
    if (!hasMeaningfulText(req.body.body)) {
      return next(AppError.badRequest("Comment text is required"));
    }

    activity.body = req.body.body;
    await activity.save();

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: "UPDATED",
      summary: "Member edited their comment",
      actorId: userId,
      actorEmail: req.user?.email || req.headers?.["x-user-email"] || null,
    });

    return res.status(200).json({ success: true, data: activity });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.name === "CastError") return next(AppError.notFound("Comment not found"));
    return next(AppError.internalServerError(error.message || "Failed to update comment"));
  }
}

/**
 * Soft-deletes a member's own portal comment, including any attachments still on it.
 * Content is preserved under meta.deleted, not wiped, matching the platform-wide
 * soft-delete convention (models/activity.model.js) - blob storage is untouched either way,
 * so a later CRM review of history can still resolve what was actually removed. To drop
 * just one attachment and keep the rest of the comment, use portalRemoveAttachment instead.
 */
async function portalDeleteComment(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    const activity = await loadMyOwnComment(tenantId, userId, issue._id, req.params.activityId);
    if (!activity) return next(AppError.notFound("Comment not found"));

    activity.meta = { deleted: true, deletedAt: new Date(), deletedBy: userId };
    await activity.save();

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: "DELETED",
      summary: activity.attachments?.length
        ? "Member deleted their comment and attachment"
        : "Member deleted their comment",
      actorId: userId,
      actorEmail: req.user?.email || req.headers?.["x-user-email"] || null,
    });

    return res.status(200).json({ success: true, data: { _id: activity._id, deleted: true } });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "CastError") return next(AppError.notFound("Comment not found"));
    return next(AppError.internalServerError(error.message || "Failed to delete comment"));
  }
}

/**
 * Removes a single attachment from a member's own portal comment. Unlike a soft-deleted
 * comment (portalDeleteComment), whose blob is deliberately left in place for audit, an
 * attachment the member explicitly removes is actually deleted from blob storage - it's the
 * one operation in this file with a real "gone for good" side effect. If nothing meaningful
 * is left on the comment afterwards (no attachments and no body text), the whole Activity is
 * soft-deleted too, same as portalDeleteComment - an empty comment shell serves no purpose.
 *
 * Not blocked on a CLOSED issue - matches portalDeleteComment (removal isn't the same kind
 * of ongoing edit that portalUpdateComment blocks there), only comment-text edits are.
 */
async function portalRemoveAttachment(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const my = await resolveMyProfileOrThrow(req, tenantId);

    const issue = await loadMyIssue(tenantId, my.profileId, req.params.id);
    if (!issue) return next(AppError.notFound("Issue not found"));

    const activity = await loadMyOwnComment(tenantId, userId, issue._id, req.params.activityId);
    if (!activity) return next(AppError.notFound("Comment not found"));

    const index = Number(req.params.index);
    const attachments = Array.isArray(activity.attachments) ? activity.attachments : [];
    const attachment = Number.isInteger(index) ? attachments[index] : null;
    if (!attachment) return next(AppError.notFound("Attachment not found"));

    if (attachment.blobPath) {
      await deleteBlob(attachment.blobPath).catch((error) => {
        console.error("[issuePortal] Failed to delete blob on attachment removal:", error.message);
      });
    }

    attachments.splice(index, 1);
    activity.markModified("attachments");

    const nothingLeft = attachments.length === 0 && !hasMeaningfulText(activity.body);
    if (nothingLeft) {
      activity.meta = { deleted: true, deletedAt: new Date(), deletedBy: userId };
    }
    await activity.save();

    recordHistory({
      tenantId,
      issueId: issue._id,
      entityType: "ACTIVITY",
      entityId: activity._id,
      action: nothingLeft ? "DELETED" : "UPDATED",
      summary: nothingLeft
        ? `Member removed an attachment (${attachment.filename}) and the now-empty comment`
        : `Member removed an attachment (${attachment.filename})`,
      actorId: userId,
      actorEmail: req.user?.email || req.headers?.["x-user-email"] || null,
    });

    return res.status(200).json({
      success: true,
      data: { _id: activity._id, attachments: activity.attachments, deleted: nothingLeft },
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error.name === "CastError") return next(AppError.notFound("Comment not found"));
    return next(AppError.internalServerError(error.message || "Failed to remove attachment"));
  }
}

module.exports = {
  portalCreateIssue,
  portalListMyIssues,
  portalGetMyIssueById,
  portalListMyIssueActivities,
  portalAddIssueComment,
  portalUpdateComment,
  portalDeleteComment,
  portalRemoveAttachment,
  portalDownloadAttachment,
};

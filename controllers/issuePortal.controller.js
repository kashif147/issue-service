const Issue = require("../models/issue.model");
const Complaint = require("../models/issue.complaint.model");
const Activity = require("../models/activity.model");
const { AppError } = require("../errors/AppError");
const issueService = require("../services/issue.service");
const profileServiceClient = require("../services/profileService.client");
const { uploadToBlob, getDownloadSasUrl, buildIssueAttachmentBlobPath } = require("../services/azure.blob.service");

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

    return res.status(200).json({ success: true, data: issue });
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

module.exports = {
  portalCreateIssue,
  portalListMyIssues,
  portalGetMyIssueById,
  portalListMyIssueActivities,
  portalAddIssueComment,
  portalDownloadAttachment,
};

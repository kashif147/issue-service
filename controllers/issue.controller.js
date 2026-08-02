const Issue = require("../models/issue.model");
// Requiring each discriminator registers it on the shared Issue model - required before any
// discriminator-typed document can be created/hydrated.
const Complaint = require("../models/issue.complaint.model");
const Ftp = require("../models/issue.ftp.model");
const Ir = require("../models/issue.ir.model");
const DataProtection = require("../models/issue.dataprotection.model");
const { AppError } = require("../errors/AppError");
const issueService = require("../services/issue.service");
const issueEvents = require("../rabbitMQ/publishers/issue.events.publisher.js");
const { publishSafely } = require("../utils/publishSafely");

// Every publish below is best-effort: a RabbitMQ hiccup must never fail the HTTP response
// that already succeeded against Mongo (same principle as issue.service.js's
// resolveContactName/resolveIroOwnerUserId - swallow and log, don't propagate). publishSafely
// itself now lives in utils/publishSafely.js, shared with
// services/dueDateScheduler.service.js which needs the identical behavior.

const DISCRIMINATOR_MODELS = {
  COMPLAINT: Complaint,
  FTP: Ftp,
  IR: Ir,
  DATA_PROTECTION: DataProtection,
};

// Fields the caller may never set/overwrite directly via create/update payloads.
const PROTECTED_FIELDS = [
  "_id",
  "tenantId",
  "issueType",
  "internalReferenceNumber",
  "caseFileNumber",
  "createdBy",
  "createdOn",
  "meta",
];

function stripProtectedFields(body) {
  const clean = { ...(body || {}) };
  for (const field of PROTECTED_FIELDS) {
    delete clean[field];
  }
  return clean;
}

function baseListFilter(req) {
  const { tenantId, userId } = req.ctx;
  const allowedTypes = issueService.getAllowedIssueTypes(req);
  return issueService.withComplaintHideFilter(
    { tenantId, issueType: { $in: allowedTypes }, "meta.deleted": { $ne: true } },
    userId,
  );
}

async function listIssues(req, res, next) {
  try {
    const { issueType, priority, issueStatus, q } = req.query;
    const filter = baseListFilter(req);
    const allowedTypes = issueService.getAllowedIssueTypes(req);

    if (issueType && allowedTypes.includes(issueType)) filter.issueType = issueType;
    if (priority) filter.priority = priority;
    if (issueStatus) filter.issueStatus = issueStatus;
    if (q) {
      const escaped = String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { caseTitle: new RegExp(escaped, "i") },
        { internalReferenceNumber: new RegExp(escaped, "i") },
      ];
    }

    // Default sort: priority (HIGH first) then most-recently-created first, per the plan's
    // grid requirements (§4.4 item 8) - priority is a string enum so a plain field sort
    // would order alphabetically (HIGH, LOW, MEDIUM), not by severity.
    const issues = await Issue.aggregate([
      { $match: filter },
      {
        $addFields: {
          _priorityWeight: {
            $switch: {
              branches: [
                { case: { $eq: ["$priority", "HIGH"] }, then: 0 },
                { case: { $eq: ["$priority", "MEDIUM"] }, then: 1 },
                { case: { $eq: ["$priority", "LOW"] }, then: 2 },
              ],
              default: 3,
            },
          },
        },
      },
      { $sort: { _priorityWeight: 1, createdOn: -1 } },
      { $project: { _priorityWeight: 0 } },
    ]);

    return res.status(200).json({ success: true, data: issues });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list issues"));
  }
}

async function getIssueById(req, res, next) {
  try {
    const filter = { ...baseListFilter(req), _id: req.params.id };
    const issue = await Issue.findOne(filter);
    if (!issue) return next(AppError.notFound("Issue not found"));
    return res.status(200).json({ success: true, data: issue });
  } catch (error) {
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to fetch issue"));
  }
}

async function createIssue(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const body = req.body || {};
    const { issueType } = body;

    if (!issueType || !DISCRIMINATOR_MODELS[issueType]) {
      return next(
        AppError.badRequest(
          `issueType must be one of ${Object.keys(DISCRIMINATOR_MODELS).join(", ")}`,
        ),
      );
    }

    const Model = DISCRIMINATOR_MODELS[issueType];
    const issue = new Model({
      ...stripProtectedFields(body),
      tenantId,
      createdBy: userId,
      createdOn: new Date(),
    });

    const userInitials = issueService.deriveInitialsFromEmail(req.user?.email);
    await issueService.prepareNewIssue(issue, { req, tenantId, userInitials });

    await issue.save();

    // Fired concurrently, not sequentially: each publish() call independently waits up to
    // ~10s for a RabbitMQ connection before giving up (rabbitmq-middleware's own connection
    // -wait-then-retry behavior) - awaiting these one after another would compound into a
    // multi-x-10s response delay if RabbitMQ is ever down. Promise.all bounds the worst case
    // to the slowest single call instead.
    const publishTasks = [
      publishSafely(() => issueEvents.publishIssueCreated(issue), "issues.issue.created.v1"),
      publishSafely(
        () =>
          issueEvents.publishIssueAudit({
            action: "create",
            tenantId,
            resourceId: String(issue._id),
            actorId: userId,
            actorEmail: req.user?.email || req.headers["x-user-email"] || null,
            after: issue.toObject(),
          }),
        "issues.issue.audit.v1 (create)",
      ),
      publishSafely(
        () => issueEvents.publishIssueReportingSnapshot(issue),
        "issues.issue.reporting.snapshot.v1 (create)",
      ),
    ];

    // High-priority issue created for owner (plan §1.4) - the reused generic in-app
    // notification event, fired directly (not via a dedicated issues.* routing key).
    if (issue.priority === "HIGH" && issue.owner?.userId) {
      publishTasks.push(
        publishSafely(
          () =>
            issueEvents.publishMemberNotificationRequested({
              tenantId,
              userId: issue.owner.userId,
              title: "Urgent: new high-priority issue assigned to you",
              body: `A new high-priority issue (${issue.internalReferenceNumber || issue.caseFileNumber}) has been assigned to you.`,
              metadata: {
                type: "ISSUE_HIGH_PRIORITY_CREATED",
                issueId: String(issue._id),
                deepLink: `/CasesDetails?issueId=${issue._id}`,
              },
            }),
          "members.member.notification.requested.v1 (high-priority-created)",
        ),
      );
    }

    await Promise.all(publishTasks);

    return res.status(201).json({ success: true, data: issue });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError(error.message || "Failed to create issue"));
  }
}

async function updateIssue(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const filter = { ...baseListFilter(req), _id: req.params.id };
    const issue = await Issue.findOne(filter);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to update issues of this type"));
    }

    const before = issue.toObject();
    const wasReferredToThirdParty = !!issue.referredToThirdParty;
    const wasOutcomeReceived = !!issue.outcomeReceivedFromThirdParty;

    Object.assign(issue, stripProtectedFields(req.body));
    issue.updatedBy = userId;
    await issue.save();
    const after = issue.toObject();

    const publishTasks = [
      publishSafely(() => issueEvents.publishIssueUpdated(issue, before, after), "issues.issue.updated.v1"),
      publishSafely(
        () =>
          issueEvents.publishIssueAudit({
            action: "update",
            tenantId,
            resourceId: String(issue._id),
            actorId: userId,
            actorEmail: req.user?.email || req.headers["x-user-email"] || null,
            before,
            after,
          }),
        "issues.issue.audit.v1 (update)",
      ),
      publishSafely(
        () => issueEvents.publishIssueReportingSnapshot(issue),
        "issues.issue.reporting.snapshot.v1 (update)",
      ),
    ];

    // IR referred/outcome-received notifications fire on a false -> true transition of
    // these two IR-specific checkboxes (plan §1.1/§1.4) - both are updated via this
    // generic route, not updateIssueStatus.
    if (issue.issueType === "IR") {
      if (!wasReferredToThirdParty && issue.referredToThirdParty) {
        publishTasks.push(publishSafely(() => issueEvents.publishIrReferred(issue), "issues.ir.referred.v1"));
      }
      if (!wasOutcomeReceived && issue.outcomeReceivedFromThirdParty) {
        publishTasks.push(
          publishSafely(
            () => issueEvents.publishIrOutcomeReceived(issue),
            "issues.ir.outcome.received.v1",
          ),
        );
      }
    }

    await Promise.all(publishTasks);

    return res.status(200).json({ success: true, data: issue });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to update issue"));
  }
}

async function updateIssueStatus(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const filter = { ...baseListFilter(req), _id: req.params.id };
    const issue = await Issue.findOne(filter);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to update issues of this type"));
    }

    const fromStatus = issue.issueStatus;

    const { issueStatus, issueStatusOther, resolution, resolutionOther, dateResolved } =
      req.body || {};

    if (issueStatus !== undefined) issue.issueStatus = issueStatus;
    if (issueStatusOther !== undefined) issue.issueStatusOther = issueStatusOther;
    if (resolution !== undefined) issue.resolution = resolution;
    if (resolutionOther !== undefined) issue.resolutionOther = resolutionOther;
    if (dateResolved !== undefined) issue.dateResolved = dateResolved;
    else if (issueStatus === "CLOSED" && !issue.dateResolved) issue.dateResolved = new Date();

    issue.updatedBy = userId;
    await issue.save();

    const publishTasks = [
      publishSafely(
        () =>
          issueEvents.publishIssueAudit({
            action: "update",
            tenantId,
            resourceId: String(issue._id),
            actorId: userId,
            actorEmail: req.user?.email || req.headers["x-user-email"] || null,
            before: { issueStatus: fromStatus },
            after: { issueStatus: issue.issueStatus, resolution: issue.resolution },
          }),
        "issues.issue.audit.v1 (status)",
      ),
      publishSafely(
        () => issueEvents.publishIssueReportingSnapshot(issue),
        "issues.issue.reporting.snapshot.v1 (status)",
      ),
    ];
    if (fromStatus !== issue.issueStatus) {
      publishTasks.push(
        publishSafely(
          () => issueEvents.publishIssueStatusChanged(issue, fromStatus, issue.issueStatus),
          "issues.issue.status.changed.v1",
        ),
      );
    }
    await Promise.all(publishTasks);

    return res.status(200).json({ success: true, data: issue });
  } catch (error) {
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to update issue status"));
  }
}

async function softDeleteIssue(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const filter = { ...baseListFilter(req), _id: req.params.id };
    const issue = await Issue.findOne(filter);
    if (!issue) return next(AppError.notFound("Issue not found"));

    if (!issueService.hasTeamWritePermission(req, issue.issueType)) {
      return next(AppError.forbidden("Not permitted to delete issues of this type"));
    }

    issue.meta.deleted = true;
    issue.meta.deletedAt = new Date();
    issue.updatedBy = userId;
    await issue.save();

    await Promise.all([
      publishSafely(
        () =>
          issueEvents.publishIssueAudit({
            action: "delete",
            tenantId,
            resourceId: String(issue._id),
            actorId: userId,
            actorEmail: req.user?.email || req.headers["x-user-email"] || null,
            after: { deleted: true },
          }),
        "issues.issue.audit.v1 (delete)",
      ),
      publishSafely(
        () => issueEvents.publishIssueReportingSnapshot(issue),
        "issues.issue.reporting.snapshot.v1 (delete)",
      ),
    ]);

    return res.status(200).json({ success: true, data: issue });
  } catch (error) {
    if (error.name === "CastError") return next(AppError.notFound("Issue not found"));
    return next(AppError.internalServerError(error.message || "Failed to delete issue"));
  }
}

module.exports = {
  listIssues,
  getIssueById,
  createIssue,
  updateIssue,
  updateIssueStatus,
  softDeleteIssue,
};

const { publisher } = require("@projectShell/rabbitmq-middleware");

// issue-service's own exchange - asserted in rabbitMQ/index.js's init({exchanges:[...]}).
// Every routing key below is already a key in rabbitmq-middleware's exchangeMapping
// (backend/rabbitmq-middleware/src/publisher.js), added ahead of this file per the
// hook-enforced rule that a publishDomainEvent("<literal>", ...) call must resolve to a
// real exchange, not silently fall back to application.events (plan §1.3).
const EXCHANGE = "issues.events";

const ROUTING_KEYS = {
  ISSUE_CREATED: "issues.issue.created.v1",
  ISSUE_UPDATED: "issues.issue.updated.v1",
  ISSUE_STATUS_CHANGED: "issues.issue.status.changed.v1",
  ACTIVITY_LOGGED: "issues.activity.logged.v1",
  IR_REFERRED: "issues.ir.referred.v1",
  IR_OUTCOME_RECEIVED: "issues.ir.outcome.received.v1",
  DUEDATE_APPROACHING: "issues.duedate.approaching.v1",
  ISSUE_AUDIT: "issues.issue.audit.v1",
  ISSUE_REPORTING_SNAPSHOT: "issues.issue.reporting.snapshot.v1",
};

// Reused, already-consumed generic "please notify this user" event
// (notification-service/rabbitMQ/listeners/memberNotificationRequested.listener.js) on
// membership.events - not issue-service's own exchange. Needs no exchangeMapping change
// (already mapped) and no notification-service code change (plan §0.B/§1.4).
const MEMBER_NOTIFICATION_REQUESTED_EVENT = "members.member.notification.requested.v1";
const MEMBER_NOTIFICATION_REQUESTED_EXCHANGE = "membership.events";

async function publishDomainEvent(eventType, data, metadata = {}) {
  const result = await publisher.publish(eventType, data, {
    tenantId: metadata.tenantId,
    correlationId: metadata.correlationId,
    exchange: metadata.exchange || EXCHANGE,
    routingKey: eventType,
    metadata: { service: "issue-service", version: "1.0", ...metadata },
  });
  if (!result.success) {
    console.error(`[issue-service] Failed to publish ${eventType}:`, result.error);
  }
  return result.success;
}

function issueSummaryPayload(issue) {
  return {
    issueId: String(issue._id),
    tenantId: issue.tenantId,
    issueType: issue.issueType,
    internalReferenceNumber: issue.internalReferenceNumber || null,
    priority: issue.priority,
    ownerTeam: issue.owner?.team || null,
    ownerUserId: issue.owner?.userId || null,
    memberIds: issue.memberIds || [],
    createdBy: issue.createdBy || null,
    issueSource: issue.issueSource || null,
  };
}

/** issues.issue.created.v1 - also drives communication-service's member-acknowledgement
 * email (filtered on issueSource === "MEMBER-IS" there, not a separate event - plan §1.4). */
async function publishIssueCreated(issue) {
  return publishDomainEvent(ROUTING_KEYS.ISSUE_CREATED, issueSummaryPayload(issue), {
    tenantId: issue.tenantId,
  });
}

async function publishIssueUpdated(issue, before, after) {
  return publishDomainEvent(
    ROUTING_KEYS.ISSUE_UPDATED,
    { issueId: String(issue._id), tenantId: issue.tenantId, before, after },
    { tenantId: issue.tenantId },
  );
}

async function publishIssueStatusChanged(issue, fromStatus, toStatus) {
  return publishDomainEvent(
    ROUTING_KEYS.ISSUE_STATUS_CHANGED,
    {
      issueId: String(issue._id),
      tenantId: issue.tenantId,
      fromStatus,
      toStatus,
      priority: issue.priority,
    },
    { tenantId: issue.tenantId },
  );
}

async function publishActivityLogged(activity, issue) {
  return publishDomainEvent(
    ROUTING_KEYS.ACTIVITY_LOGGED,
    {
      issueId: String(issue._id),
      tenantId: activity.tenantId,
      activityId: String(activity._id),
      activityType: activity.activityType,
      createdBy: activity.createdBy || null,
      ownerUserId: issue.owner?.userId || null,
      sendNotification: !!activity.sendNotification,
      pertinentToFileReview: !!activity.pertinentToFileReview,
    },
    { tenantId: activity.tenantId },
  );
}

async function publishIrReferred(issue) {
  return publishDomainEvent(
    ROUTING_KEYS.IR_REFERRED,
    {
      issueId: String(issue._id),
      tenantId: issue.tenantId,
      caseFileNumber: issue.caseFileNumber || null,
      ownerTeam: issue.owner?.team || null,
      referredAt: new Date().toISOString(),
    },
    { tenantId: issue.tenantId },
  );
}

async function publishIrOutcomeReceived(issue) {
  return publishDomainEvent(
    ROUTING_KEYS.IR_OUTCOME_RECEIVED,
    {
      issueId: String(issue._id),
      tenantId: issue.tenantId,
      caseFileNumber: issue.caseFileNumber || null,
      outcome: issue.resolution || null,
    },
    { tenantId: issue.tenantId },
  );
}

/** Fired by the due-date-approaching scheduler (a later slice, plan §1.4) - email half. */
async function publishDueDateApproaching(issue, { iroPaUserId } = {}) {
  return publishDomainEvent(
    ROUTING_KEYS.DUEDATE_APPROACHING,
    {
      issueId: String(issue._id),
      tenantId: issue.tenantId,
      dueDate: issue.dueDate || null,
      ownerUserId: issue.owner?.userId || null,
      iroPaUserId: iroPaUserId || null,
      priorityEscalatedTo: "HIGH",
    },
    { tenantId: issue.tenantId },
  );
}

/** Mirrors account-service's finance.audit.v1 publisher shape exactly (plan §1.3/§3.2). */
async function publishIssueAudit({
  action,
  tenantId,
  resourceId,
  actorId,
  actorEmail,
  before = null,
  after = null,
  metadata = {},
}) {
  if (!tenantId || !action) return false;
  return publishDomainEvent(
    ROUTING_KEYS.ISSUE_AUDIT,
    { action, tenantId: String(tenantId), resourceId, actorId, actorEmail, before, after, metadata },
    { tenantId: String(tenantId), action },
  );
}

/** Denormalized snapshot for reporting-service's issue_listing table (plan §1.3/§3.3). */
async function publishIssueReportingSnapshot(issue) {
  return publishDomainEvent(
    ROUTING_KEYS.ISSUE_REPORTING_SNAPSHOT,
    {
      issueId: String(issue._id),
      tenantId: issue.tenantId,
      issueType: issue.issueType,
      internalReferenceNumber: issue.internalReferenceNumber || null,
      caseFileNumber: issue.caseFileNumber || null,
      memberIds: issue.memberIds || [],
      priority: issue.priority,
      issueStatus: issue.issueStatus,
      ownerTeam: issue.owner?.team || null,
      ownerUserId: issue.owner?.userId || null,
      dateReceived: issue.dateReceived || null,
      dateResolved: issue.dateResolved || null,
      dueDate: issue.dueDate || null,
      resolution: issue.resolution || null,
      lastUpdated: issue.lastActivityAt && issue.lastActivityAt > issue.updatedAt
        ? issue.lastActivityAt
        : issue.updatedAt,
      isCurrent: !issue.meta?.deleted,
    },
    { tenantId: issue.tenantId },
  );
}

/**
 * The reused generic in-app notification event (plan §0.B/§1.4) - explicit exchange since
 * issue-service doesn't own/assert membership.events itself.
 */
async function publishMemberNotificationRequested({ tenantId, userId, title, body, metadata = {} }) {
  if (!tenantId || !userId) return false;
  return publishDomainEvent(
    MEMBER_NOTIFICATION_REQUESTED_EVENT,
    { tenantId, userId, title, body, metadata },
    { tenantId, exchange: MEMBER_NOTIFICATION_REQUESTED_EXCHANGE },
  );
}

module.exports = {
  EXCHANGE,
  ROUTING_KEYS,
  publishDomainEvent,
  publishIssueCreated,
  publishIssueUpdated,
  publishIssueStatusChanged,
  publishActivityLogged,
  publishIrReferred,
  publishIrOutcomeReceived,
  publishDueDateApproaching,
  publishIssueAudit,
  publishIssueReportingSnapshot,
  publishMemberNotificationRequested,
};

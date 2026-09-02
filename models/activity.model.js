const mongoose = require("mongoose");
const Issue = require("./issue.model");

const ACTIVITY_TYPES = [
  "EMAIL",
  "CALL",
  "LETTER",
  "TASK",
  "NOTE",
  "APPOINTMENT",
  "SMS",
  "SOCIAL_MEDIA_QUERY",
  "FAX",
  // "Advice Given" is handled as an Activity tagged ADVICE_GIVEN rather than a duplicate
  // free-text field on Issue - see the plan's models section.
  "ADVICE_GIVEN",
];

const ActivitySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    issueId: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, index: true },

    activityType: { type: String, enum: ACTIVITY_TYPES, required: true },
    subject: { type: String, default: null },
    body: { type: String, default: null },
    interactionDate: { type: Date, default: Date.now },
    createdBy: { type: String, default: null },

    // The doc's explicit filter field - indexed so the activities list can filter on it
    // directly.
    pertinentToFileReview: { type: Boolean, default: false, index: true },

    // Owner-notify only fires when this is true (see the post-save hook below).
    sendNotification: { type: Boolean, default: true },

    attachments: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // Gates visibility on the member portal (controllers/issuePortal.controller.js's
    // portalListMyIssueActivities filters on this) - default false so CRM's existing
    // internal notes/calls stay hidden from the member by default. Portal-created comments
    // (controllers/issuePortal.controller.js#portalAddIssueComment) always set this true;
    // CRM can optionally set it true on its own createActivity calls to reply visibly.
    visibleToMember: { type: Boolean, default: false },

    // Soft-delete, same pattern as Issue.meta (models/issue.model.js) - a deleted comment's
    // content is preserved (not wiped) so services/history.service.js's DELETED entry can
    // show what was actually deleted, not just that something was. Every list/read query
    // must filter "meta.deleted": { $ne: true } to exclude these.
    meta: {
      deleted: { type: Boolean, default: false },
      deletedAt: { type: Date, default: null },
      deletedBy: { type: String, default: null },
    },
  },
  { timestamps: true },
);

// Bump Issue.lastActivityAt on every new activity, publish an activity-logged event for
// audit/reporting, and notify the issue owner when someone else logs an activity and
// hasn't opted out via sendNotification (plan §1.4).
ActivitySchema.post("save", async function bumpIssueLastActivity(doc) {
  // A soft-delete is also a .save() (flips meta.deleted) - it's not a new/updated activity
  // for notification/reporting purposes, so skip every side effect below for it. The
  // DELETED history entry is recorded separately by the controller, not this hook.
  if (doc.meta?.deleted) return;
  try {
    const issue = await Issue.findByIdAndUpdate(
      doc.issueId,
      { $set: { lastActivityAt: doc.interactionDate || new Date() } },
      { new: true },
    );
    if (!issue) return;

    // Lazily required to avoid a hard circular-ish coupling between every model load and
    // RabbitMQ - mirrors services/issue.service.js's lazy require of iroResolution.service.
    const issueEvents = require("../rabbitMQ/publishers/issue.events.publisher.js");

    await issueEvents.publishActivityLogged(doc, issue);

    if (doc.sendNotification && doc.createdBy !== issue.owner?.userId && issue.owner?.userId) {
      await issueEvents.publishMemberNotificationRequested({
        tenantId: doc.tenantId,
        userId: issue.owner.userId,
        title: `New activity on ${issue.internalReferenceNumber || issue.caseFileNumber || "your issue"}`,
        body: `A new ${doc.activityType} activity was logged on this issue.`,
        metadata: {
          type: "ISSUE_ACTIVITY_LOGGED",
          issueId: String(issue._id),
          deepLink: `/CasesDetails?issueId=${issue._id}`,
        },
      });
    }
  } catch (error) {
    console.error("[activity.model] Failed to bump Issue.lastActivityAt / publish events:", error.message);
  }
});

const Activity = mongoose.model("Activity", ActivitySchema);

module.exports = Activity;
module.exports.ACTIVITY_TYPES = ACTIVITY_TYPES;

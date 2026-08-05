const mongoose = require("mongoose");

// Base schema, common to every issueType. Discriminators (issue.complaint.model.js,
// issue.ftp.model.js, issue.ir.model.js, issue.dataprotection.model.js) each add their
// type-specific field set on top of this via Issue.discriminator(...). issueType is the
// discriminator key, per the plan (models section, §1.1).
//
// Enum values below are transcribed directly from
// `docs/Issue Management Requirements.docx` (see the "Logging an Issue" section), mapped
// onto SCREAMING_SNAKE_CASE constants - the *Other free-text fields exist because the doc's
// dropdowns each include an "Other" option with a companion textbox.
const ISSUE_TYPES = ["COMPLAINT", "FTP", "IR", "DP"];

const ISSUE_STATUSES = [
  "ACTIVE",
  "ACTIVE_BEFORE_BOARD",
  "ACTIVE_INQUIRY",
  "ACTIVE_PPC",
  "PENDING_THIRD_PARTY_HEARING",
  "PENDING_RESPONSE_MEMBER",
  "PENDING_RESPONSE_EXTERNAL",
  "AWAITING_OUTCOME_THIRD_PARTY",
  "FOR_REVIEW_BY_OFFICIAL",
  "OTHER",
  "CLOSED",
];

// Codes match user-service's Lookup values under LookupType "ISSUESRC" exactly (including
// the "OFFICAL-IS" typo in the seeded data) - the frontend dropdown is sourced live from
// that lookup (see hooks/useIssueLookups.js in the frontend app), so these enums must stay
// in lockstep with whatever codes are seeded there.
const ISSUE_SOURCES = ["MEMBER-IS", "PA-IS", "OFFICAL-IS", "INFODPT-IS", "EC-IS", "SM-IS", "OTHR-IS"];

// Codes match user-service's Lookup values under LookupType "ORIGIN" exactly - see the
// ISSUE_SOURCES comment above.
const ORIGINS = [
  "PHONE-O",
  "EMAIL-O",
  "PORTAL-O",
  "INPERSON-O",
  "RBEC-O",
  "REP-O",
  "DCTO-O",
  "LETTER-O",
  "SOCMED-O",
];

const OWNER_TEAMS = ["COMPLAINTS", "FTP", "IR", "DATA_PROTECTION"];

// Codes match user-service's Lookup values under LookupType "RESOLUTON" exactly - see the
// ISSUE_SOURCES comment above. Unlike ISSUE_SOURCES/ORIGINS, Resolution's Lookup values are
// hierarchical (each is a child of a specific Issue Type's Lookup value, currently only
// seeded under FTP and IR) - the dropdown options are scoped per issue type at fetch time
// (services/lookup.service.client.js's fetchResolutions), but this base-schema enum stays a
// flat union of every valid code, same as ISSUE_STATUSES.
const RESOLUTIONS = [
  "SEC55PTI",
  "NCFAPPC",
  "CAUAPPCCFI",
  "COR",
  "SEC58-55",
  "LL",
  "NFCFM",
  "WE",
  "WTP",
  "OTHR",
  "CLSD",
];

const PRIORITIES = ["LOW", "MEDIUM", "HIGH"];

const IssueSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },

    // Unique per tenant+year, format "##-YY" (see services/referenceNumberGenerator.js).
    internalReferenceNumber: { type: String, default: null, index: true },

    // Discriminator key.
    issueType: { type: String, enum: ISSUE_TYPES, required: true, index: true },

    // Auto-set as "{contactName} {internalReferenceNumber}" - see services/issue.service.js.
    caseTitle: { type: String, default: null },

    issueStatus: { type: String, enum: ISSUE_STATUSES, default: "ACTIVE" },
    issueStatusOther: { type: String, maxlength: 45, default: null },

    createdBy: { type: String, default: null },
    createdOn: { type: Date, default: Date.now },
    dateReceived: { type: Date, default: null },
    dateResolved: { type: Date, default: null },
    description: { type: String, default: null },

    issueSource: { type: String, enum: ISSUE_SOURCES, default: null },
    issueSourceOther: { type: String, default: null },

    linkedIssueIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Issue", default: [] }],

    // Profile-service profileIds - single for individual, multi for group/national.
    memberIds: { type: [String], default: [] },

    // Cross-service ref to profile-service Group._id - a plain String, never a local ref
    // (see no-cross-db-mongo rule / cross-service-auth skill).
    groupId: { type: String, default: null },

    origin: { type: String, enum: ORIGINS, default: null },

    owner: {
      team: { type: String, enum: OWNER_TEAMS, default: null },
      userId: { type: String, default: null },
    },

    resolution: { type: String, enum: RESOLUTIONS, default: null },
    resolutionOther: { type: String, default: null },

    priority: { type: String, enum: PRIORITIES, default: "MEDIUM", index: true },

    // The hide-from-self field - COMPLAINT only, but kept on the base schema since the
    // complaint-hide filter (services/issue.service.js) runs across the single Issue
    // collection regardless of issueType.
    complaintAgainstUserId: { type: String, default: null },

    // Denormalized via Activity's post-save hook (models/activity.model.js). The response
    // mapper computes lastUpdated = max(lastActivityAt, updatedAt) - not stored here.
    lastActivityAt: { type: Date, default: null },

    // Set by services/dueDateScheduler.service.js (plan §1.4) each time it escalates this
    // issue's priority to HIGH for an approaching due date - guards against a scheduler
    // restart mid-day re-sending the same day's notification. Only meaningful for
    // COMPLAINT/DP issues (the only two types with a dueDate field at all -
    // see models/issue.complaint.model.js / issue.dataprotection.model.js).
    lastDueDateReminderAt: { type: Date, default: null },

    meta: {
      deleted: { type: Boolean, default: false },
      deletedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
    discriminatorKey: "issueType",
    collection: "issues",
  },
);

IssueSchema.index({ tenantId: 1, issueType: 1, "meta.deleted": 1 });
IssueSchema.index({ tenantId: 1, priority: 1, createdOn: -1 });
IssueSchema.index({ tenantId: 1, internalReferenceNumber: 1 }, { unique: true, sparse: true });

// issueStatusOther required only when issueStatus === "OTHER".
IssueSchema.pre("validate", function issueStatusOtherRequired(next) {
  if (this.issueStatus === "OTHER" && !this.issueStatusOther) {
    return next(new Error("issueStatusOther is required when issueStatus is OTHER"));
  }
  next();
});

const Issue = mongoose.model("Issue", IssueSchema);

module.exports = Issue;
module.exports.ISSUE_TYPES = ISSUE_TYPES;
module.exports.ISSUE_STATUSES = ISSUE_STATUSES;
module.exports.ISSUE_SOURCES = ISSUE_SOURCES;
module.exports.ORIGINS = ORIGINS;
module.exports.OWNER_TEAMS = OWNER_TEAMS;
module.exports.RESOLUTIONS = RESOLUTIONS;
module.exports.PRIORITIES = PRIORITIES;

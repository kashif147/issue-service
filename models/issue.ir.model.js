const mongoose = require("mongoose");
const Issue = require("./issue.model");

// Individual vs Group vs National, per the requirements doc's "so single, group and
// national issues can be captured against the correct members" line (Logging an Issue
// intro) and the "Members: Grid of contacts, to be used if IR Case Type = Group" line
// (Industrial Relations field list) - the field the Members grid's visibility depends on.
// Codes match user-service's Lookup values under LookupType "CASETYPE" exactly (INDV, not
// INDIVIDUAL) - see models/issue.model.js's ISSUE_SOURCES comment.
const CASE_TYPES = ["INDV", "GROUP", "NATIONAL"];

const IrSchema = new mongoose.Schema({
  // Unique, format "YY-{initials}-{6digit}" - see services/referenceNumberGenerator.js.
  caseFileNumber: { type: String, default: null, index: true },

  // Drives whether the frontend's Members grid (multi-contact) is shown vs a single member
  // link - see CASE_TYPES comment above.
  caseType: { type: String, enum: CASE_TYPES, default: "INDV" },

  correspondenceWithExternalParty: { type: Boolean, default: false },

  // NOT a local ref - Issue Designations live in user-service's generic Lookup/LookupType
  // system (LookupType code "ISSUEDESG"), per the plan. This stores that Lookup's _id as a
  // plain String, resolved read-only via services/lookup.service.client.js (owned by a
  // separate parallel workstream - see that file's own note once it lands).
  issueDesignation: { type: String, default: null },

  resolvedByUserId: { type: String, default: null },
  membershipVerified: { type: Boolean, default: false },

  // Each drives a notification on false -> true transition (see plan §1.1/§1.4 - wired up
  // in a later slice once RabbitMQ publishing exists).
  referredToThirdParty: { type: Boolean, default: false },
  submissionIssuedToThirdParty: { type: Boolean, default: false },
  outcomeReceivedFromThirdParty: { type: Boolean, default: false },

  wrcCaseNumber: { type: String, default: null },
});

IrSchema.index({ tenantId: 1, caseFileNumber: 1 }, { unique: true, sparse: true });

const Ir = Issue.discriminator("IR", IrSchema);

module.exports = Ir;
module.exports.CASE_TYPES = CASE_TYPES;

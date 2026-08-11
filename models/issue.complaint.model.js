const mongoose = require("mongoose");
const Issue = require("./issue.model");

// Codes match user-service's Lookup values under LookupType "CMPLNTYPE" exactly (see
// models/issue.model.js's ISSUE_SOURCES comment for why - same live-lookup-driven dropdown
// convention, hooks/useIssueLookups.js in the frontend app).
const COMPLAINT_TYPES = ["MOM", "MOO", "MOSP", "TPC"];

const SOLICITORS = ["O_CONNORS", "OTHER"];

const RespondentSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    relationship: { type: String, default: null },
  },
  { _id: false },
);

const ComplaintSchema = new mongoose.Schema({
  // Auto-set as "Contact Name + Internal Reference No" - see services/issue.service.js.
  complainant: { type: String, default: null },

  complaintType: { type: String, enum: COMPLAINT_TYPES, required: true },

  externalSolicitorInvolved: { type: Boolean, default: false },
  solicitor: { type: String, enum: SOLICITORS, default: null },
  solicitorOther: { type: String, default: null },

  resolvedByUserId: { type: String, default: null },
  dueDate: { type: Date, default: null },

  externalAgency: { type: String, default: null },
  externalCaseRef: { type: String, default: null },

  respondents: { type: [RespondentSchema], default: [] },

  // Required only when complaintType === "MOSP" (Member On Service Provider) - enforced
  // below in pre("validate"), not just the frontend.
  serviceProvider: { type: String, default: null },
});

ComplaintSchema.pre("validate", function serviceProviderRequiredForMemberOnServiceProvider(next) {
  if (this.complaintType === "MOSP" && !this.serviceProvider) {
    return next(new Error("serviceProvider is required when complaintType is MOSP"));
  }
  next();
});

// Required only when complaintType === "MOM" (Member On Member) - `complainant` itself is
// auto-derived from memberIds[0] (assignAutoTitles in services/issue.service.js, run before
// issue.save()), so the real caller-supplied input to validate is memberIds, not the
// complainant string.
ComplaintSchema.pre("validate", function complainantRequiredForMemberOnMember(next) {
  if (this.complaintType === "MOM" && (!Array.isArray(this.memberIds) || this.memberIds.length === 0)) {
    return next(new Error("A complainant (Related Member) is required when complaintType is Member On Member"));
  }
  next();
});

const Complaint = Issue.discriminator("COMPLAINT", ComplaintSchema);

module.exports = Complaint;
module.exports.COMPLAINT_TYPES = COMPLAINT_TYPES;
module.exports.SOLICITORS = SOLICITORS;

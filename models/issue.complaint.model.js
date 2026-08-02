const mongoose = require("mongoose");
const Issue = require("./issue.model");

const COMPLAINT_TYPES = [
  "MEMBER_ON_MEMBER",
  "MEMBER_ON_ORGANISATION",
  "MEMBER_ON_SERVICE_PROVIDER",
  "THIRD_PARTY_COMPLAINT",
];

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

  complaintType: { type: String, enum: COMPLAINT_TYPES, default: null },

  externalSolicitorInvolved: { type: Boolean, default: false },
  solicitor: { type: String, enum: SOLICITORS, default: null },
  solicitorOther: { type: String, default: null },

  resolvedByUserId: { type: String, default: null },
  dueDate: { type: Date, default: null },

  externalAgency: { type: String, default: null },
  externalCaseRef: { type: String, default: null },

  respondents: { type: [RespondentSchema], default: [] },

  // Required only when complaintType === "MEMBER_ON_SERVICE_PROVIDER" - enforced below in
  // pre("validate"), not just the frontend.
  serviceProvider: { type: String, default: null },
});

ComplaintSchema.pre("validate", function serviceProviderRequiredForMemberOnServiceProvider(next) {
  if (this.complaintType === "MEMBER_ON_SERVICE_PROVIDER" && !this.serviceProvider) {
    return next(
      new Error("serviceProvider is required when complaintType is MEMBER_ON_SERVICE_PROVIDER"),
    );
  }
  next();
});

const Complaint = Issue.discriminator("COMPLAINT", ComplaintSchema);

module.exports = Complaint;
module.exports.COMPLAINT_TYPES = COMPLAINT_TYPES;
module.exports.SOLICITORS = SOLICITORS;

const mongoose = require("mongoose");
const Issue = require("./issue.model");

const SEVERITIES = ["LOW", "MEDIUM", "HIGH"];
// Named "dpStatus" (not "status") to avoid colliding with the base schema's issueStatus.
const DP_STATUSES = ["OPEN", "CLOSED"];
const DP_ISSUE_TYPES = ["DSAR", "DP_COMPLAINT", "DATA_BREACH"];
const SOLICITORS = ["O_CONNORS", "OTHER"];

const DataProtectionSchema = new mongoose.Schema({
  severity: { type: String, enum: SEVERITIES, default: null },
  dpStatus: { type: String, enum: DP_STATUSES, default: "OPEN" },
  dpIssueType: { type: String, enum: DP_ISSUE_TYPES, default: null },

  externalAgency: { type: String, default: null },

  dpcInformed: { type: Boolean, default: false },
  // Required when dpcInformed is true.
  dpcInformedDatetime: { type: Date, default: null },

  externalSolicitorInvolved: { type: Boolean, default: false },
  solicitor: { type: String, enum: SOLICITORS, default: null },
  solicitorOther: { type: String, default: null },

  dueDate: { type: Date, default: null },
  resolvedByUserId: { type: String, default: null },
});

DataProtectionSchema.pre("validate", function dpcInformedDatetimeRequired(next) {
  if (this.dpcInformed && !this.dpcInformedDatetime) {
    return next(new Error("dpcInformedDatetime is required when dpcInformed is true"));
  }
  next();
});

const DataProtection = Issue.discriminator("DATA_PROTECTION", DataProtectionSchema);

module.exports = DataProtection;
module.exports.SEVERITIES = SEVERITIES;
module.exports.DP_STATUSES = DP_STATUSES;
module.exports.DP_ISSUE_TYPES = DP_ISSUE_TYPES;
module.exports.SOLICITORS = SOLICITORS;

const mongoose = require("mongoose");

// The one piece of genuinely new directory data this feature needs - "PA of the assigned
// IRO" has no equivalent anywhere else in the platform (no reportsTo/managerId field on
// User). One row per IRO who has a PA on file; the due-date-approaching scheduler (a later
// slice) falls back to notifying the IRO directly when no row exists for them. See the
// plan's models section (§1.1) for the full rationale.
const IroPaAssignmentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    iroUserId: { type: String, required: true },
    paUserId: { type: String, required: true },
  },
  { timestamps: true },
);

IroPaAssignmentSchema.index({ tenantId: 1, iroUserId: 1 }, { unique: true });

module.exports = mongoose.model("IroPaAssignment", IroPaAssignmentSchema);

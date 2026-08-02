const mongoose = require("mongoose");

/**
 * Atomic counters used for reference-number generation
 * (see services/referenceNumberGenerator.js). Copies the atomic-counter
 * pattern from account-service's src/models/sepaReferenceSequence.model.js
 * (findOneAndUpdate + $inc + upsert) rather than profile-service's
 * race-prone "find max + 1" approach.
 *
 * scope/scopeKey examples:
 *   scope: "ISSUE_INTERNAL_REF", scopeKey: "26"          -> internalReferenceNumber "##-YY"
 *   scope: "ISSUE_IR_CASE_FILE", scopeKey: "26-JD"        -> IR caseFileNumber "YY-{initials}-{6digit}"
 */
const SequenceSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    scope: { type: String, required: true, trim: true },
    scopeKey: { type: String, required: true, trim: true },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

SequenceSchema.index({ tenantId: 1, scope: 1, scopeKey: 1 }, { unique: true });

module.exports = mongoose.model("Sequence", SequenceSchema);

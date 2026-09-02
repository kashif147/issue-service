const mongoose = require("mongoose");

// Backs the CRM Case Details "History" section (previously a hardcoded single mock entry -
// see controllers/issue.controller.js/issueActivity.controller.js's recordHistory() calls
// for where these get written). One row per tracked change to an Issue or one of its
// Activities - not a generic Mongoose changeset log, only the fields callers explicitly
// summarize via services/history.service.js#summarizeObjectDiff.
const ENTITY_TYPES = ["ISSUE", "ACTIVITY"];
const ACTIONS = ["CREATED", "UPDATED", "DELETED"];

const HistoryEntrySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    // Always the parent Issue's id, even for ACTIVITY entries - lets the History tab query
    // by issue alone regardless of which entity actually changed.
    issueId: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, index: true },
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    action: { type: String, enum: ACTIONS, required: true },
    // Human-readable, e.g. "priority: MEDIUM -> HIGH; description changed" - built by
    // services/history.service.js, not free text from the caller.
    summary: { type: String, required: true },
    changedFields: { type: [String], default: [] },
    actorId: { type: String, default: null },
    actorEmail: { type: String, default: null },
  },
  { timestamps: true },
);

HistoryEntrySchema.index({ tenantId: 1, issueId: 1, createdAt: -1 });

module.exports = mongoose.model("HistoryEntry", HistoryEntrySchema);
module.exports.ENTITY_TYPES = ENTITY_TYPES;
module.exports.ACTIONS = ACTIONS;

const HistoryEntry = require("../models/historyEntry.model");

// Fields deliberately excluded from diffs - housekeeping/derived/internal, never something
// a CRM user thinks of as "a change" (caseTitle/complainant are auto-derived from
// memberIds, already covered by memberIds itself changing).
const IGNORED_DIFF_FIELDS = [
  "_id",
  "__v",
  "updatedAt",
  "createdAt",
  "createdOn",
  "lastActivityAt",
  "lastDueDateReminderAt",
  "meta",
  "tenantId",
  "issueId",
  "internalReferenceNumber",
  "caseFileNumber",
  "caseTitle",
  "complainant",
  "createdBy",
];

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "(none)";
  if (typeof value === "object") return "(changed)";
  const str = String(value);
  return str.length > 60 ? `${str.slice(0, 57)}...` : str;
}

/**
 * Diffs two plain objects (e.g. Mongoose .toObject() results) over every key present in
 * either, minus IGNORED_DIFF_FIELDS - not a fixed field allowlist, so discriminator-specific
 * fields (FTP/IR/DP-only fields) are covered automatically without enumerating them here.
 * Returns null if nothing tracked actually changed (e.g. only updatedAt moved).
 */
function summarizeObjectDiff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  keys.forEach((key) => {
    if (IGNORED_DIFF_FIELDS.includes(key)) return;
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      changed.push(key);
    }
  });
  if (changed.length === 0) return null;

  const summary = changed
    .map((key) => {
      const beforeVal = before?.[key];
      const afterVal = after?.[key];
      const isPrimitive = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
      if (isPrimitive(beforeVal) && isPrimitive(afterVal)) {
        return `${key}: ${formatValue(beforeVal)} → ${formatValue(afterVal)}`;
      }
      return `${key} changed`;
    })
    .join("; ");

  return { summary, changedFields: changed };
}

/**
 * Best-effort, fire-and-forget (swallow and log, same principle as
 * utils/publishSafely.js) - a history-write failure must never fail the request that
 * already succeeded against the actual Issue/Activity document.
 */
async function recordHistory({
  tenantId,
  issueId,
  entityType,
  entityId,
  action,
  summary,
  changedFields = [],
  actorId,
  actorEmail,
}) {
  try {
    await HistoryEntry.create({
      tenantId,
      issueId,
      entityType,
      entityId,
      action,
      summary,
      changedFields,
      actorId: actorId || null,
      actorEmail: actorEmail || null,
    });
  } catch (error) {
    console.error("[history.service] Failed to record history entry:", error.message);
  }
}

module.exports = { recordHistory, summarizeObjectDiff };

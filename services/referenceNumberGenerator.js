const Sequence = require("../models/sequence.model");

const SCOPE_INTERNAL_REF = "ISSUE_INTERNAL_REF";
const SCOPE_IR_CASE_FILE = "ISSUE_IR_CASE_FILE";

function twoDigitYear(date = new Date()) {
  return String(date.getFullYear()).slice(-2);
}

/**
 * Atomically increment and return the next counter for a given scope+scopeKey, scoped by
 * tenant - copies account-service's sepaReferenceSequence.model.js pattern
 * (findOneAndUpdate + $inc + upsert) rather than a race-prone "find max + 1" read.
 */
async function nextSequence(tenantId, scope, scopeKey) {
  const doc = await Sequence.findOneAndUpdate(
    { tenantId, scope, scopeKey },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return doc.seq;
}

/**
 * internalReferenceNumber, format "##-YY" (e.g. "01-26"), scoped by tenant+year. Applies to
 * every issueType, not just IR.
 */
async function generateInternalReferenceNumber(tenantId, date = new Date()) {
  const yy = twoDigitYear(date);
  const seq = await nextSequence(tenantId, SCOPE_INTERNAL_REF, yy);
  return `${String(seq).padStart(2, "0")}-${yy}`;
}

/**
 * IR-only caseFileNumber, format "YY-{initials}-{6digit}", scoped by tenant+year+initials.
 * The 6-digit part is the sequence counter itself, zero-padded - NOT random - which avoids a
 * collision-retry loop.
 */
async function generateCaseFileNumber(tenantId, initials, date = new Date()) {
  const yy = twoDigitYear(date);
  const normalizedInitials = String(initials || "XX").toUpperCase();
  const scopeKey = `${yy}-${normalizedInitials}`;
  const seq = await nextSequence(tenantId, SCOPE_IR_CASE_FILE, scopeKey);
  return `${yy}-${normalizedInitials}-${String(seq).padStart(6, "0")}`;
}

module.exports = {
  generateInternalReferenceNumber,
  generateCaseFileNumber,
};

const Issue = require("../models/issue.model");
const issueEvents = require("../rabbitMQ/publishers/issue.events.publisher.js");
const { publishSafely } = require("../utils/publishSafely");

// Due-date-approaching scheduler (plan §1.4).
//
// SPEC AMBIGUITY, RESOLVED: the plan flags that the due-date-approaching rule reads
// IR-flavored ("PA of the assigned IRO") but, per the requirements doc's own field lists,
// only Complaint.dueDate and DataProtection.dueDate actually exist - IR and FTP have no
// dueDate field at all (confirmed against the live schema: models/issue.ir.model.js and
// models/issue.ftp.model.js declare no dueDate). This is the literal-spec interpretation:
// Complaint/DataProtection ONLY. Extending this to IR/FTP is blocked on those types
// getting a dueDate field added first - a business decision, not something to guess at
// here - so DUE_DATE_ISSUE_TYPES below deliberately does not include "IR"/"FTP".
const DUE_DATE_ISSUE_TYPES = ["COMPLAINT", "DP"];

const LOOKAHEAD_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Exported separately so the scan filter shape itself is unit-testable without touching
 * Mongo. Matches the plan's literal query (§1.4 step 1) plus one addition: the
 * lastDueDateReminderAt $or guard (step 5) so a scheduler restart mid-day doesn't re-match
 * an issue it already escalated/notified earlier today. No tenant filter at the top level
 * - this is a background job scanning across all tenants, not a per-request query (plan's
 * explicit instruction); tenantId is carried per-document into every downstream
 * publish/notification call instead.
 */
function buildDueDateScanFilter(now = new Date()) {
  const lookaheadCutoff = new Date(now.getTime() + LOOKAHEAD_DAYS * ONE_DAY_MS);
  return {
    issueType: { $in: DUE_DATE_ISSUE_TYPES },
    dueDate: { $gte: now, $lte: lookaheadCutoff },
    issueStatus: { $ne: "CLOSED" },
    priority: { $ne: "HIGH" },
    "meta.deleted": { $ne: true },
    $or: [
      { lastDueDateReminderAt: null },
      { lastDueDateReminderAt: { $lt: startOfDay(now) } },
    ],
  };
}

/**
 * Recipient resolution - a second judgment call flowing from the same spec ambiguity
 * above. The plan's due-date notification recipient is "PA of the assigned IRO"
 * (services/iroResolution.service.js's resolvePaForIro), but Complaint/DataProtection
 * issues are NOT auto-routed to an IRO on create - only IR gets owner.userId auto-set via
 * iroResolution.resolveForProfile (see services/issue.service.js's autoRouteOwner: IR-only
 * branch). These two issue types genuinely may have no IRO/PA concept at all, so forcing
 * an IRO resolution here would be fitting a mechanism that doesn't apply to them. Fall
 * back sensibly instead: whoever the issue is actually assigned to (issue.owner.userId -
 * set on these types via manual assignment, not auto-routing) is who gets notified,
 * skipping the IRO/PA machinery entirely. If no owner is set, there is genuinely no
 * resolvable recipient - the issue is still escalated to HIGH priority (so it surfaces in
 * the grid) but no notification is sent, logged rather than thrown.
 */
function resolveRecipientUserId(issue) {
  return issue.owner?.userId || null;
}

async function notifyRecipient(issue, recipientUserId) {
  await Promise.all([
    publishSafely(
      () =>
        issueEvents.publishMemberNotificationRequested({
          tenantId: issue.tenantId,
          userId: recipientUserId,
          title: `Due date approaching on ${issue.internalReferenceNumber || "your issue"}`,
          body: `This issue's due date is within the next ${LOOKAHEAD_DAYS} days and has been escalated to HIGH priority.`,
          metadata: {
            type: "ISSUE_DUEDATE_APPROACHING",
            issueId: String(issue._id),
            deepLink: `/CasesDetails?issueId=${issue._id}`,
          },
        }),
      "members.member.notification.requested.v1 (duedate-approaching)",
    ),
    publishSafely(
      () => issueEvents.publishDueDateApproaching(issue, { iroPaUserId: recipientUserId }),
      "issues.duedate.approaching.v1",
    ),
  ]);
}

/**
 * Plan §1.4 steps 2-5 for a single matched issue: escalate priority, stamp
 * lastDueDateReminderAt (so it drops out of tomorrow's/a restarted scan's match set
 * regardless of whether the notification below succeeds), then resolve+notify.
 */
async function processDueDateIssue(issue) {
  issue.priority = "HIGH";
  issue.lastDueDateReminderAt = new Date();
  await issue.save();

  const recipientUserId = resolveRecipientUserId(issue);
  if (!recipientUserId) {
    console.warn(
      `[dueDateScheduler] Issue ${issue._id} (${issue.internalReferenceNumber || issue.issueType}) has no owner.userId - escalated to HIGH priority but no notification recipient could be resolved.`,
    );
    return { notified: false };
  }

  await notifyRecipient(issue, recipientUserId);
  return { notified: true };
}

/**
 * Core scan-and-escalate logic (plan §1.4 steps 1-5) - the unit-testable piece, independent
 * of the interval wrapper below. Each issue is processed sequentially and independently: a
 * failure on one issue (bad save, publish throwing despite publishSafely, etc.) is caught
 * and logged, never aborting the rest of the scan.
 */
async function scanAndEscalateDueDateIssues(now = new Date()) {
  const filter = buildDueDateScanFilter(now);
  const issues = await Issue.find(filter);

  let escalated = 0;
  let notified = 0;

  for (const issue of issues) {
    try {
      const result = await processDueDateIssue(issue);
      escalated += 1;
      if (result.notified) notified += 1;
    } catch (error) {
      console.error(`[dueDateScheduler] Failed to process issue ${issue._id}:`, error.message);
    }
  }

  return { scanned: issues.length, escalated, notified };
}

let intervalHandle = null;

/**
 * In-process daily interval - single-instance, no leader election, same pattern as
 * account-service's batch.processing.cron.service.js / directDebitPrepare.cron.service.js
 * (see backend/account-service/.claude/rules/background-jobs.md, and the platform-wide
 * backend/.claude/rules/single-instance-assumptions.md). If issue-service is ever run as
 * more than one instance, this scheduler runs redundantly on every instance rather than
 * coordinating - that limitation should be documented in issue-service's own CLAUDE.md
 * once one exists, the same way account-service's does for its own cron jobs.
 */
function startDueDateScheduler({ intervalMs = ONE_DAY_MS, runImmediately = true } = {}) {
  if (intervalHandle) return intervalHandle;

  const run = () => {
    scanAndEscalateDueDateIssues().catch((error) => {
      console.error("[dueDateScheduler] Scan failed:", error.message);
    });
  };

  if (runImmediately) run();

  intervalHandle = setInterval(run, intervalMs);
  // Don't let this timer alone keep the process alive (e.g. during tests/shutdown).
  if (typeof intervalHandle.unref === "function") intervalHandle.unref();

  return intervalHandle;
}

function stopDueDateScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  DUE_DATE_ISSUE_TYPES,
  LOOKAHEAD_DAYS,
  buildDueDateScanFilter,
  resolveRecipientUserId,
  scanAndEscalateDueDateIssues,
  startDueDateScheduler,
  stopDueDateScheduler,
};

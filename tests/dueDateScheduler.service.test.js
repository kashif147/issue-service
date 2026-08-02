// Unit tests for services/dueDateScheduler.service.js's scan-and-escalate logic (plan
// §1.4). Follows the same mocking convention tests/setup.js already establishes for
// route-level tests (mock RabbitMQ, mock Mongo) rather than spinning up real infra or a
// live interval/cron trigger - here that means mocking the Issue model's `find` (no real
// Mongo connection in this suite) and the RabbitMQ publisher module directly (a level
// below what tests/setup.js's `jest.mock("../rabbitMQ", ...)` covers, since
// rabbitMQ/publishers/issue.events.publisher.js talks to
// @projectShell/rabbitmq-middleware directly rather than going through rabbitMQ/index.js).

jest.mock("../models/issue.model", () => ({
  find: jest.fn(),
}));

jest.mock("../rabbitMQ/publishers/issue.events.publisher.js", () => ({
  publishMemberNotificationRequested: jest.fn().mockResolvedValue(true),
  publishDueDateApproaching: jest.fn().mockResolvedValue(true),
}));

const Issue = require("../models/issue.model");
const issueEvents = require("../rabbitMQ/publishers/issue.events.publisher.js");
const {
  DUE_DATE_ISSUE_TYPES,
  buildDueDateScanFilter,
  resolveRecipientUserId,
  scanAndEscalateDueDateIssues,
} = require("../services/dueDateScheduler.service");

function makeMockIssue(overrides = {}) {
  const issue = {
    _id: "issue-1",
    tenantId: "tenant-1",
    issueType: "COMPLAINT",
    issueStatus: "ACTIVE",
    priority: "MEDIUM",
    internalReferenceNumber: "01-26",
    dueDate: new Date(),
    owner: { team: "COMPLAINTS", userId: "owner-user-1" },
    lastDueDateReminderAt: null,
    ...overrides,
  };
  issue.save = jest.fn().mockResolvedValue(issue);
  return issue;
}

describe("dueDateScheduler.service", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("buildDueDateScanFilter", () => {
    it("scopes to COMPLAINT/DATA_PROTECTION only (the literal-spec interpretation)", () => {
      expect(DUE_DATE_ISSUE_TYPES).toEqual(["COMPLAINT", "DATA_PROTECTION"]);
      expect(DUE_DATE_ISSUE_TYPES).not.toContain("IR");
      expect(DUE_DATE_ISSUE_TYPES).not.toContain("FTP");

      const filter = buildDueDateScanFilter(new Date("2026-08-02T00:00:00.000Z"));
      expect(filter.issueType).toEqual({ $in: ["COMPLAINT", "DATA_PROTECTION"] });
      expect(filter.issueStatus).toEqual({ $ne: "CLOSED" });
      expect(filter.priority).toEqual({ $ne: "HIGH" });
      expect(filter["meta.deleted"]).toEqual({ $ne: true });
      expect(filter.dueDate.$gte).toEqual(new Date("2026-08-02T00:00:00.000Z"));
      expect(filter.dueDate.$lte).toEqual(new Date("2026-08-09T00:00:00.000Z"));
    });

    it("excludes issues already reminded today via the lastDueDateReminderAt guard", () => {
      const now = new Date("2026-08-02T12:00:00.000Z");
      const filter = buildDueDateScanFilter(now);
      // Compute "start of day" the same way the implementation does (local midnight) rather
      // than hardcoding a UTC string, so this test doesn't depend on the runner's timezone.
      const expectedStartOfDay = new Date(now);
      expectedStartOfDay.setHours(0, 0, 0, 0);
      expect(filter.$or).toEqual([
        { lastDueDateReminderAt: null },
        { lastDueDateReminderAt: { $lt: expectedStartOfDay } },
      ]);
    });
  });

  describe("resolveRecipientUserId", () => {
    it("resolves to owner.userId directly - no IRO/PA machinery for these issue types", () => {
      const issue = makeMockIssue({ owner: { team: "COMPLAINTS", userId: "owner-abc" } });
      expect(resolveRecipientUserId(issue)).toBe("owner-abc");
    });

    it("resolves to null when the issue has no owner assigned", () => {
      const issue = makeMockIssue({ owner: {} });
      expect(resolveRecipientUserId(issue)).toBeNull();
    });
  });

  describe("scanAndEscalateDueDateIssues", () => {
    it("escalates priority to HIGH, stamps lastDueDateReminderAt, and notifies the owner", async () => {
      const issue = makeMockIssue();
      Issue.find.mockResolvedValue([issue]);

      const result = await scanAndEscalateDueDateIssues();

      expect(issue.priority).toBe("HIGH");
      expect(issue.lastDueDateReminderAt).toBeInstanceOf(Date);
      expect(issue.save).toHaveBeenCalledTimes(1);

      expect(issueEvents.publishMemberNotificationRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          userId: "owner-user-1",
          metadata: expect.objectContaining({ type: "ISSUE_DUEDATE_APPROACHING" }),
        }),
      );
      expect(issueEvents.publishDueDateApproaching).toHaveBeenCalledWith(
        issue,
        { iroPaUserId: "owner-user-1" },
      );

      expect(result).toEqual({ scanned: 1, escalated: 1, notified: 1 });
    });

    it("still escalates priority but skips notification when no owner is resolvable", async () => {
      const issue = makeMockIssue({ owner: {} });
      Issue.find.mockResolvedValue([issue]);

      const result = await scanAndEscalateDueDateIssues();

      expect(issue.priority).toBe("HIGH");
      expect(issue.save).toHaveBeenCalledTimes(1);
      expect(issueEvents.publishMemberNotificationRequested).not.toHaveBeenCalled();
      expect(issueEvents.publishDueDateApproaching).not.toHaveBeenCalled();
      // Priority escalation still counts even though no notification recipient existed -
      // "escalated" tracks the Mongo write succeeding, not whether anyone was notified.
      expect(result).toEqual({ scanned: 1, escalated: 1, notified: 0 });
    });

    it("continues processing remaining issues when one issue's save throws", async () => {
      const failing = makeMockIssue({ _id: "issue-fail" });
      failing.save = jest.fn().mockRejectedValue(new Error("mongo hiccup"));
      const ok = makeMockIssue({ _id: "issue-ok" });
      Issue.find.mockResolvedValue([failing, ok]);

      const result = await scanAndEscalateDueDateIssues();

      expect(ok.save).toHaveBeenCalledTimes(1);
      expect(ok.priority).toBe("HIGH");
      expect(result).toEqual({ scanned: 2, escalated: 1, notified: 1 });
    });

    it("never throws when the publisher rejects (publishSafely swallows it)", async () => {
      const issue = makeMockIssue();
      Issue.find.mockResolvedValue([issue]);
      issueEvents.publishMemberNotificationRequested.mockRejectedValue(new Error("amqp down"));
      issueEvents.publishDueDateApproaching.mockRejectedValue(new Error("amqp down"));

      await expect(scanAndEscalateDueDateIssues()).resolves.toEqual({
        scanned: 1,
        escalated: 1,
        notified: 1,
      });
    });

    it("returns a no-op result when nothing matches", async () => {
      Issue.find.mockResolvedValue([]);
      const result = await scanAndEscalateDueDateIssues();
      expect(result).toEqual({ scanned: 0, escalated: 0, notified: 0 });
    });
  });
});

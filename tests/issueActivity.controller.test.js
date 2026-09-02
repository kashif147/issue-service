// Unit tests for controllers/issueActivity.controller.js's createActivity - specifically the
// "activity text is mandatory" validation added this session (previously body.body was
// entirely optional, letting the CRM "Log Activity" button save an empty activity). Follows
// tests/issue.search.controller.test.js's convention: exercise the exported function
// directly with a mocked res/next, spying on Mongo calls rather than a full supertest round
// trip.

jest.mock("../services/azure.blob.service", () => ({
  uploadToBlob: jest.fn(),
  getDownloadSasUrl: jest.fn(),
  buildIssueAttachmentBlobPath: jest.fn(() => "issue-attachments/tenant-1/issue-1/uuid-file.pdf"),
}));

// recordHistory does real I/O (HistoryEntry.create) - mocked to keep these unit tests fast/
// deterministic. summarizeObjectDiff is a pure function, kept real via requireActual so
// diff-dependent behavior (e.g. updateActivity only recording history when something
// tracked actually changed) is still genuinely exercised.
jest.mock("../services/history.service", () => ({
  ...jest.requireActual("../services/history.service"),
  recordHistory: jest.fn(),
}));

const Issue = require("../models/issue.model");
const Activity = require("../models/activity.model");
const issueService = require("../services/issue.service");
const azureBlobService = require("../services/azure.blob.service");
const historyService = require("../services/history.service");
const issueActivityController = require("../controllers/issueActivity.controller");

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq({ body = {}, params = { id: "issue-1" }, tenantId = "tenant-1", userId = "user-1", permissions = ["issues-complaints:write"] } = {}) {
  return {
    body,
    params,
    headers: {},
    user: { email: "staff@example.com" },
    ctx: { tenantId, userId, permissions },
  };
}

describe("issueActivity.controller createActivity", () => {
  let findOneSpy;
  let createSpy;

  beforeEach(() => {
    findOneSpy = jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    createSpy = jest.spyOn(Activity, "create").mockResolvedValue({ _id: "activity-1" });
    jest.spyOn(issueService, "getAllowedIssueTypes").mockReturnValue(["COMPLAINT"]);
    jest.spyOn(issueService, "hasTeamWritePermission").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    historyService.recordHistory.mockClear();
  });

  it("400s when activityType is missing", async () => {
    const req = makeReq({ body: { body: "some text" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.createActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("400s when body is missing entirely", async () => {
    const req = makeReq({ body: { activityType: "NOTE" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.createActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(next.mock.calls[0][0].message).toMatch(/text is required/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("400s when body is whitespace only", async () => {
    const req = makeReq({ body: { activityType: "NOTE", body: "   \n\t  " } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.createActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("400s when body is ReactQuill's empty-editor HTML", async () => {
    const req = makeReq({ body: { activityType: "NOTE", body: "<p><br></p>" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.createActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("creates the activity when body has real text", async () => {
    const req = makeReq({ body: { activityType: "NOTE", body: "<p>Called the member</p>" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.createActivity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ body: "<p>Called the member</p>", activityType: "NOTE" }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("400s when the issue is CLOSED, even with a valid activityType/body", async () => {
    findOneSpy.mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT", issueStatus: "CLOSED" });
    const req = makeReq({ body: { activityType: "NOTE", body: "<p>Called the member</p>" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.createActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(next.mock.calls[0][0].message).toMatch(/closed issue/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  afterAll(() => {
    findOneSpy?.mockRestore?.();
  });
});

describe("issueActivity.controller uploadIssueAttachment", () => {
  beforeEach(() => {
    jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    jest.spyOn(Activity, "create").mockResolvedValue({ _id: "activity-1", createdAt: new Date("2026-01-01") });
    jest.spyOn(issueService, "getAllowedIssueTypes").mockReturnValue(["COMPLAINT"]);
    jest.spyOn(issueService, "hasTeamWritePermission").mockReturnValue(true);
    azureBlobService.uploadToBlob.mockResolvedValue("https://blob.example/whatever");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    historyService.recordHistory.mockClear();
  });

  it("400s when no file is attached", async () => {
    const req = makeReq({ params: { id: "issue-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.uploadIssueAttachment(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(Activity.create).not.toHaveBeenCalled();
  });

  it("403s when the caller lacks team write permission", async () => {
    issueService.hasTeamWritePermission.mockReturnValue(false);
    const req = makeReq({ params: { id: "issue-1" } });
    req.file = { originalname: "doc.pdf", mimetype: "application/pdf", size: 1234, buffer: Buffer.from("x") };
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.uploadIssueAttachment(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(403);
    expect(azureBlobService.uploadToBlob).not.toHaveBeenCalled();
  });

  it("400s when the issue is CLOSED", async () => {
    Issue.findOne.mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT", issueStatus: "CLOSED" });
    const req = makeReq({ params: { id: "issue-1" } });
    req.file = { originalname: "doc.pdf", mimetype: "application/pdf", size: 1234, buffer: Buffer.from("x") };
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.uploadIssueAttachment(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(next.mock.calls[0][0].message).toMatch(/closed issue/i);
    expect(azureBlobService.uploadToBlob).not.toHaveBeenCalled();
  });

  it("uploads the file to blob storage and creates a bare Activity to hold it", async () => {
    const req = makeReq({ params: { id: "issue-1" } });
    req.file = { originalname: "doc.pdf", mimetype: "application/pdf", size: 1234, buffer: Buffer.from("x") };
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.uploadIssueAttachment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(azureBlobService.uploadToBlob).toHaveBeenCalledWith(
      "issue-attachments/tenant-1/issue-1/uuid-file.pdf",
      req.file.buffer,
      "application/pdf",
      "doc.pdf",
    );
    expect(Activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        activityType: "NOTE",
        body: null,
        sendNotification: false,
        attachments: [
          expect.objectContaining({ filename: "doc.pdf", contentType: "application/pdf", size: 1234 }),
        ],
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("issueActivity.controller listIssueAttachments", () => {
  beforeEach(() => {
    jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    jest.spyOn(issueService, "getAllowedIssueTypes").mockReturnValue(["COMPLAINT"]);
    jest.spyOn(issueService, "hasPermission").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    historyService.recordHistory.mockClear();
  });

  it("flattens attachments across activities into a single list", async () => {
    jest.spyOn(Activity, "find").mockReturnValue({
      sort: jest.fn().mockResolvedValue([
        {
          _id: "activity-1",
          createdAt: new Date("2026-01-02"),
          createdBy: "user-1",
          attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 10 }],
        },
        {
          _id: "activity-2",
          createdAt: new Date("2026-01-01"),
          createdBy: "user-2",
          attachments: [
            { filename: "b.pdf", contentType: "application/pdf", size: 20 },
            { filename: "c.png", contentType: "image/png", size: 30 },
          ],
        },
      ]),
    });
    const req = makeReq({ params: { id: "issue-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.listIssueAttachments(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveLength(3);
    expect(data[0]).toEqual(
      expect.objectContaining({ activityId: "activity-1", index: 0, filename: "a.pdf" }),
    );
    expect(data[2]).toEqual(
      expect.objectContaining({ activityId: "activity-2", index: 1, filename: "c.png" }),
    );
  });
});

describe("issueActivity.controller updateActivity", () => {
  let mockSave;

  beforeEach(() => {
    mockSave = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(issueService, "getAllowedIssueTypes").mockReturnValue(["COMPLAINT"]);
    jest.spyOn(issueService, "hasTeamWritePermission").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    historyService.recordHistory.mockClear();
  });

  function mockExistingActivity(overrides = {}) {
    const activity = {
      _id: "activity-1",
      issueId: "issue-1",
      tenantId: "tenant-1",
      activityType: "NOTE",
      body: "original text",
      save: mockSave,
      ...overrides,
    };
    // Real Mongoose documents support .toObject() (used by updateActivity to snapshot
    // before/after for the history diff) - a plain mock object needs it added explicitly,
    // as a live snapshot (not a fixed one taken at mock-setup time) since the controller
    // mutates `activity` in place between the two calls.
    activity.toObject = () => ({ ...activity });
    jest.spyOn(Activity, "findOne").mockResolvedValue(activity);
    jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    return activity;
  }

  it("400s when the edit would clear the activity's text", async () => {
    const activity = mockExistingActivity();
    const req = makeReq({ params: { activityId: "activity-1" }, body: { body: "<p><br></p>" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.updateActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
    expect(activity.body).toBe("original text");
  });

  it("allows updating other fields without touching body", async () => {
    mockExistingActivity();
    const req = makeReq({
      params: { activityId: "activity-1" },
      body: { visibleToMember: true, pertinentToFileReview: true },
    });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.updateActivity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("updates the body text when it has real content", async () => {
    const activity = mockExistingActivity();
    const req = makeReq({
      params: { activityId: "activity-1" },
      body: { body: "<p>Updated note</p>" },
    });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.updateActivity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(activity.body).toBe("<p>Updated note</p>");
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("strips protected fields (createdBy, tenantId, issueId, _id) from the update", async () => {
    const activity = mockExistingActivity({ createdBy: "original-user" });
    const req = makeReq({
      params: { activityId: "activity-1" },
      body: { createdBy: "attacker", tenantId: "other-tenant", body: "<p>ok</p>" },
    });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.updateActivity(req, res, next);

    expect(activity.createdBy).toBe("original-user");
    expect(activity.tenantId).toBe("tenant-1");
  });

  it("records an UPDATED history entry with a diff summary when body actually changes", async () => {
    mockExistingActivity();
    const req = makeReq({
      params: { activityId: "activity-1" },
      body: { body: "<p>Updated note</p>" },
    });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.updateActivity(req, res, next);

    expect(historyService.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "ACTIVITY",
        entityId: "activity-1",
        action: "UPDATED",
        actorId: "user-1",
      }),
    );
  });

  it("does not record history when the update changes nothing tracked", async () => {
    mockExistingActivity();
    const req = makeReq({
      params: { activityId: "activity-1" },
      body: { body: "original text" },
    });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.updateActivity(req, res, next);

    expect(historyService.recordHistory).not.toHaveBeenCalled();
  });
});

describe("issueActivity.controller deleteActivity", () => {
  let mockSave;

  beforeEach(() => {
    mockSave = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(issueService, "getAllowedIssueTypes").mockReturnValue(["COMPLAINT"]);
    jest.spyOn(issueService, "hasTeamWritePermission").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    historyService.recordHistory.mockClear();
  });

  it("404s when the activity doesn't exist or is already deleted", async () => {
    jest.spyOn(Activity, "findOne").mockResolvedValue(null);
    const req = makeReq({ params: { activityId: "missing" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.deleteActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
  });

  it("403s when the caller lacks team write permission", async () => {
    issueService.hasTeamWritePermission.mockReturnValue(false);
    jest.spyOn(Activity, "findOne").mockResolvedValue({ _id: "activity-1", issueId: "issue-1", save: mockSave });
    jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    const req = makeReq({ params: { activityId: "activity-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.deleteActivity(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("soft-deletes the activity and records a DELETED history entry", async () => {
    const activity = {
      _id: "activity-1",
      issueId: "issue-1",
      activityType: "NOTE",
      save: mockSave,
    };
    jest.spyOn(Activity, "findOne").mockResolvedValue(activity);
    jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    const req = makeReq({ params: { activityId: "activity-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.deleteActivity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(activity.meta).toEqual(
      expect.objectContaining({ deleted: true, deletedBy: "user-1" }),
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(historyService.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "ACTIVITY", action: "DELETED", actorId: "user-1" }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("excludes already-deleted activities from being found again", async () => {
    const findOneSpy = jest.spyOn(Activity, "findOne").mockResolvedValue(null);
    const req = makeReq({ params: { activityId: "activity-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.deleteActivity(req, res, next);

    expect(findOneSpy).toHaveBeenCalledWith(
      expect.objectContaining({ "meta.deleted": { $ne: true } }),
    );
  });
});

describe("issueActivity.controller listHistory", () => {
  beforeEach(() => {
    jest.spyOn(Issue, "findOne").mockResolvedValue({ _id: "issue-1", issueType: "COMPLAINT" });
    jest.spyOn(issueService, "getAllowedIssueTypes").mockReturnValue(["COMPLAINT"]);
    jest.spyOn(issueService, "hasPermission").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    historyService.recordHistory.mockClear();
  });

  it("returns history entries for the issue, newest first", async () => {
    const HistoryEntry = require("../models/historyEntry.model");
    const sortMock = jest.fn().mockResolvedValue([{ _id: "h1", summary: "Issue created" }]);
    jest.spyOn(HistoryEntry, "find").mockReturnValue({ sort: sortMock });
    const req = makeReq({ params: { id: "issue-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.listHistory(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(sortMock).toHaveBeenCalledWith({ createdAt: -1 });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [{ _id: "h1", summary: "Issue created" }],
    });
  });

  it("403s when the caller lacks team read permission", async () => {
    issueService.hasPermission.mockReturnValue(false);
    const req = makeReq({ params: { id: "issue-1" } });
    const res = makeRes();
    const next = jest.fn();

    await issueActivityController.listHistory(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(403);
  });
});

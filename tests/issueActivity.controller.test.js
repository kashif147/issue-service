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

const Issue = require("../models/issue.model");
const Activity = require("../models/activity.model");
const issueService = require("../services/issue.service");
const azureBlobService = require("../services/azure.blob.service");
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

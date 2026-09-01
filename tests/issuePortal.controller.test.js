// Unit tests for controllers/issuePortal.controller.js - the member-portal issue-creation/
// self-service surface (POST /issues/portal, GET /issues/portal/mine, etc.), gated by the
// platform's generic "portal" permission rather than the CRM "issues"/"issues-<team>" ones.
// Follows tests/issue.search.controller.test.js's convention: exercise the exported
// function directly with a mocked res/next and spy on Mongo calls rather than a full
// supertest round trip, and mock profileService.client since it's an outbound HTTP call.
//
// Issue.findOne/find are spied on (not jest.mock("../models/issue.model")) for the same
// reason issue.search.controller.test.js does: this controller module also requires
// issue.complaint.model.js at load time, registering it via Issue.discriminator(...) - a
// full jest.mock of issue.model would strip that and throw on require. Complaint itself IS
// jest.mock'd (its constructor is exercised directly by portalCreateIssue, not just read).

jest.mock("../services/profileService.client", () => ({
  getMyProfile: jest.fn(),
  searchProfiles: jest.fn(),
}));

jest.mock("../services/azure.blob.service", () => ({
  uploadToBlob: jest.fn(),
  getDownloadSasUrl: jest.fn(),
  buildIssueAttachmentBlobPath: jest.fn(() => "issue-attachments/tenant-1/issue-1/uuid-file.pdf"),
}));

const mockComplaintSave = jest.fn();
jest.mock("../models/issue.complaint.model", () => {
  const MockComplaint = jest.fn().mockImplementation(function ctor(data) {
    Object.assign(this, data);
    this._id = "new-issue-id";
    this.save = mockComplaintSave;
  });
  MockComplaint.COMPLAINT_TYPES = ["MOM", "MOO", "MOSP", "TPC"];
  return MockComplaint;
});

const Issue = require("../models/issue.model");
const Activity = require("../models/activity.model");
const Complaint = require("../models/issue.complaint.model");
const profileServiceClient = require("../services/profileService.client");
const issueService = require("../services/issue.service");
const issuePortalController = require("../controllers/issuePortal.controller");

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq({ body = {}, params = {}, tenantId = "tenant-1", userId = "user-1", file } = {}) {
  return {
    body,
    params,
    file,
    ctx: { tenantId, userId },
    user: { email: "member@example.com" },
  };
}

describe("issuePortal.controller portalCreateIssue", () => {
  let prepareNewIssueSpy;
  let publishSpy;

  beforeEach(() => {
    profileServiceClient.getMyProfile.mockResolvedValue({ profileId: "my-profile-id" });
    mockComplaintSave.mockResolvedValue(undefined);
    prepareNewIssueSpy = jest.spyOn(issueService, "prepareNewIssue").mockResolvedValue();
    publishSpy = jest.spyOn(issueService, "publishIssueCreatedEvents").mockResolvedValue();
  });

  afterEach(() => {
    jest.clearAllMocks();
    prepareNewIssueSpy.mockRestore();
    publishSpy.mockRestore();
  });

  it("400s when complaintType is missing", async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(Complaint).not.toHaveBeenCalled();
  });

  it("400s when complaintType is not a known code", async () => {
    const req = makeReq({ body: { complaintType: "BOGUS" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("400s when the caller's own profile can't be resolved", async () => {
    profileServiceClient.getMyProfile.mockResolvedValue(null);
    const req = makeReq({ body: { complaintType: "MOO" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(Complaint).not.toHaveBeenCalled();
  });

  it("400s for MOM without relatedMember or a named respondent", async () => {
    const req = makeReq({ body: { complaintType: "MOM" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(Complaint).not.toHaveBeenCalled();
    expect(profileServiceClient.searchProfiles).not.toHaveBeenCalled();
  });

  it("never auto-matches relatedMember against profile-service - memberIds stays just the submitter's own profile", async () => {
    const req = makeReq({ body: { complaintType: "MOM", relatedMember: "Kashif Khan" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(profileServiceClient.searchProfiles).not.toHaveBeenCalled();
    const constructedWith = Complaint.mock.calls[0][0];
    expect(constructedWith.memberIds).toEqual(["my-profile-id"]);
    expect(constructedWith.respondents).toEqual([
      { name: "Kashif Khan", email: null, phone: null, relationship: null },
    ]);
  });

  it("accepts an explicit respondents array in place of relatedMember", async () => {
    const req = makeReq({
      body: {
        complaintType: "MOM",
        respondents: [{ name: "Kashif Khan", relationship: "Colleague" }],
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const constructedWith = Complaint.mock.calls[0][0];
    expect(constructedWith.memberIds).toEqual(["my-profile-id"]);
    expect(constructedWith.respondents).toEqual([
      { name: "Kashif Khan", relationship: "Colleague" },
    ]);
  });

  it("creates a COMPLAINT for a valid MOM submission, unlinked pending CRM's manual match", async () => {
    const req = makeReq({
      body: { complaintType: "MOM", relatedMember: "Other Member", description: "test" },
    });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(Complaint).toHaveBeenCalledTimes(1);
    const constructedWith = Complaint.mock.calls[0][0];
    expect(constructedWith.memberIds).toEqual(["my-profile-id"]);
    expect(constructedWith.issueType).toBe("COMPLAINT");
    expect(constructedWith.createdViaPortal).toBe(true);
    expect(constructedWith.description).toBe("test");
    expect(mockComplaintSave).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("ignores smuggled owner/priority/issueType/issueStatus fields", async () => {
    const req = makeReq({
      body: {
        complaintType: "MOO",
        owner: { userId: "sneaky-user" },
        priority: "HIGH",
        issueType: "FTP",
        issueStatus: "CLOSED",
      },
    });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalCreateIssue(req, res, next);

    const constructedWith = Complaint.mock.calls[0][0];
    expect(constructedWith.owner).toBeUndefined();
    expect(constructedWith.priority).toBeUndefined();
    expect(constructedWith.issueStatus).toBeUndefined();
    expect(constructedWith.issueType).toBe("COMPLAINT");
  });

  it("defaults dateReceived to now when not provided", async () => {
    const req = makeReq({ body: { complaintType: "TPC" } });
    const res = makeRes();
    const next = jest.fn();

    const before = Date.now();
    await issuePortalController.portalCreateIssue(req, res, next);
    const after = Date.now();

    const constructedWith = Complaint.mock.calls[0][0];
    expect(constructedWith.dateReceived.getTime()).toBeGreaterThanOrEqual(before);
    expect(constructedWith.dateReceived.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("issuePortal.controller portalListMyIssues", () => {
  let findSpy;

  beforeEach(() => {
    profileServiceClient.getMyProfile.mockResolvedValue({ profileId: "my-profile-id" });
    findSpy = jest.spyOn(Issue, "find").mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
  });

  afterEach(() => {
    jest.clearAllMocks();
    findSpy.mockRestore();
  });

  it("filters strictly by the caller's own resolved profileId, no team-visibility filtering", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalListMyIssues(req, res, next);

    expect(findSpy).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      memberIds: "my-profile-id",
      "meta.deleted": { $ne: true },
    });
  });
});

describe("issuePortal.controller portalAddIssueComment", () => {
  let findOneSpy;

  beforeEach(() => {
    profileServiceClient.getMyProfile.mockResolvedValue({ profileId: "my-profile-id" });
    jest.spyOn(Activity, "create").mockResolvedValue({ _id: "activity-1" });
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (findOneSpy) findOneSpy.mockRestore();
  });

  it("400s when the issue is CLOSED", async () => {
    findOneSpy = jest
      .spyOn(Issue, "findOne")
      .mockResolvedValue({ _id: "issue-1", issueStatus: "CLOSED" });
    const req = makeReq({ params: { id: "issue-1" }, body: { body: "a comment" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalAddIssueComment(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(Activity.create).not.toHaveBeenCalled();
  });

  it("400s when neither a comment body nor a file is provided", async () => {
    findOneSpy = jest
      .spyOn(Issue, "findOne")
      .mockResolvedValue({ _id: "issue-1", issueStatus: "ACTIVE" });
    const req = makeReq({ params: { id: "issue-1" }, body: {} });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalAddIssueComment(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(Activity.create).not.toHaveBeenCalled();
  });

  it("404s when the issue doesn't belong to the caller (or doesn't exist)", async () => {
    findOneSpy = jest.spyOn(Issue, "findOne").mockResolvedValue(null);
    const req = makeReq({ params: { id: "not-mine" }, body: { body: "hi" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalAddIssueComment(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
  });

  it("creates a visibleToMember NOTE activity on an open issue", async () => {
    findOneSpy = jest
      .spyOn(Issue, "findOne")
      .mockResolvedValue({ _id: "issue-1", issueStatus: "ACTIVE" });
    const req = makeReq({ params: { id: "issue-1" }, body: { body: "a comment" } });
    const res = makeRes();
    const next = jest.fn();

    await issuePortalController.portalAddIssueComment(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(Activity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "issue-1",
        activityType: "NOTE",
        body: "a comment",
        visibleToMember: true,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

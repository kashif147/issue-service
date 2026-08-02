// Unit tests for controllers/issue.controller.js's searchIssues ("Find Issues", requirements
// doc's "Find Issues" section). Follows tests/dueDateScheduler.service.test.js's convention
// of exercising the exported function directly with a mocked Mongo call, rather than a full
// supertest round trip through auth + policy-middleware's live /policy/evaluate HTTP call
// (which nothing in this suite mocks - see tests/issue.search.routes.test.js for the
// route-is-mounted-behind-auth check that stays at the supertest level).
//
// Issue.aggregate is spied on (not jest.mock("../models/issue.model")) because the
// controller module also requires every discriminator model
// (issue.complaint/ftp/ir/dataprotection.model.js) at load time purely to register them via
// Issue.discriminator(...) - a full jest.mock would strip that method and throw on require.

jest.mock("../services/profileService.client", () => ({
  searchProfiles: jest.fn(),
}));

const Issue = require("../models/issue.model");
const profileServiceClient = require("../services/profileService.client");
const issueController = require("../controllers/issue.controller");

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq({ q, permissions = [], tenantId = "tenant-1", userId = "user-1" } = {}) {
  return {
    query: q === undefined ? {} : { q },
    ctx: { tenantId, userId, permissions },
  };
}

describe("issue.controller searchIssues", () => {
  let aggregateSpy;

  beforeEach(() => {
    aggregateSpy = jest.spyOn(Issue, "aggregate").mockResolvedValue([]);
    profileServiceClient.searchProfiles.mockResolvedValue([]);
  });

  afterEach(() => {
    aggregateSpy.mockRestore();
    jest.clearAllMocks();
  });

  it("400s when q is missing", async () => {
    const req = makeReq({ permissions: ["issues-complaints:read"] });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(aggregateSpy).not.toHaveBeenCalled();
  });

  it("matches internalReferenceNumber/caseFileNumber/wrcCaseNumber via the same regex-escape pattern as listIssues", async () => {
    const req = makeReq({ q: "01-26", permissions: ["issues-complaints:read"] });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(aggregateSpy).toHaveBeenCalledTimes(1);
    const pipeline = aggregateSpy.mock.calls[0][0];
    const match = pipeline[0].$match;
    const orFields = match.$or.map((clause) => Object.keys(clause)[0]);
    expect(orFields).toEqual(
      expect.arrayContaining(["internalReferenceNumber", "caseFileNumber", "wrcCaseNumber"]),
    );
    expect(match.$or[0].internalReferenceNumber).toBeInstanceOf(RegExp);
    expect(match.$or[0].internalReferenceNumber.test("01-26")).toBe(true);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  it("adds an exact issueType clause when q case-insensitively matches a known issue type", async () => {
    const req = makeReq({ q: "ir", permissions: ["issues-complaints:read", "issues-ir:read"] });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.$or).toEqual(expect.arrayContaining([{ issueType: "IR" }]));
  });

  it("adds a memberIds $in clause from matched profile-service profiles", async () => {
    profileServiceClient.searchProfiles.mockResolvedValue([
      { _id: "profile-1" },
      { _id: "profile-2" },
    ]);
    const req = makeReq({ q: "Smith", permissions: ["issues-complaints:read"] });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.$or).toEqual(
      expect.arrayContaining([{ memberIds: { $in: ["profile-1", "profile-2"] } }]),
    );
  });

  it("degrades to local-only results when profileServiceClient.searchProfiles rejects", async () => {
    profileServiceClient.searchProfiles.mockRejectedValue(new Error("profile-service down"));
    const req = makeReq({ q: "Smith", permissions: ["issues-complaints:read"] });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.$or.some((clause) => "memberIds" in clause)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("team-visibility: a caller without issues-ir:read gets IR excluded from the filter even when q matches", async () => {
    const req = makeReq({
      q: "IR",
      permissions: ["issues-complaints:read"], // no issues-ir:read
    });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.issueType).toEqual({ $in: ["COMPLAINT"] });
    expect(match.issueType.$in).not.toContain("IR");
  });

  it("team-visibility: a caller with no team read permissions at all gets an impossible-to-match filter, not an unscoped one", async () => {
    const req = makeReq({ q: "01-26", permissions: [] });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.issueType).toEqual({ $in: [] });
  });

  it("applies the complaint-hide filter (excludes issues complained against the caller) the same as listIssues", async () => {
    const req = makeReq({
      q: "01-26",
      permissions: ["issues-complaints:read"],
      userId: "user-42",
    });
    const res = makeRes();
    const next = jest.fn();

    await issueController.searchIssues(req, res, next);

    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.complaintAgainstUserId).toEqual({ $ne: "user-42" });
  });
});

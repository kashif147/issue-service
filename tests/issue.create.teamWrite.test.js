// POST /issues (controllers/issue.controller.js#createIssue) - the route floor is the base
// issues:write permission, but the team a new issue belongs to is chosen by the caller via
// body.issueType. Create must therefore also require the exact issues-<team>:write permission
// for that issueType (issue.service.js#hasTeamWritePermission, the same check update / status /
// delete already apply to the loaded document). Persistence, numbering, events and history
// are stubbed so only the authorization decision is exercised.

jest.mock("../services/history.service", () => ({
  recordHistory: jest.fn(),
  summarizeObjectDiff: jest.fn(),
}));

const mongoose = require("mongoose");
const issueController = require("../controllers/issue.controller");
const issueService = require("../services/issue.service");

const TEAM_WRITE = {
  COMPLAINT: "issues-complaints:write",
  FTP: "issues-ftp:write",
  IR: "issues-ir:write",
  DP: "issues-dataprotection:write",
};
const ISSUE_TYPES = Object.keys(TEAM_WRITE);

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function create({ issueType, permissions, userType = "CRM" }) {
  const req = {
    body: { issueType, memberIds: [] },
    ctx: { tenantId: "tenant-a", userId: "user-1", userType, permissions },
    user: { email: "first.last@example.test" },
    headers: {},
  };
  const res = makeRes();
  const next = jest.fn();
  await issueController.createIssue(req, res, next);
  const err = next.mock.calls[0]?.[0];
  return { status: err ? err.status : res.status.mock.calls[0]?.[0], err, res };
}

describe("issue.controller createIssue team write enforcement", () => {
  let saveSpy;

  beforeEach(() => {
    saveSpy = jest.spyOn(mongoose.Model.prototype, "save").mockImplementation(function save() {
      return Promise.resolve(this);
    });
    jest.spyOn(issueService, "prepareNewIssue").mockResolvedValue();
    jest.spyOn(issueService, "publishIssueCreatedEvents").mockResolvedValue();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects a team the caller cannot write (issues:write + issues-ftp:write creating COMPLAINT) with 403", async () => {
    const { status, err } = await create({
      issueType: "COMPLAINT",
      permissions: ["issues:read", "issues:write", "issues-ftp:read", "issues-ftp:write"],
    });
    expect(status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(issueService.publishIssueCreatedEvents).not.toHaveBeenCalled();
  });

  it("does not accept team READ as team write", async () => {
    const { status } = await create({
      issueType: "IR",
      permissions: ["issues:write", "issues-ir:read"],
    });
    expect(status).toBe(403);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it.each(ISSUE_TYPES)("allows %s when the caller holds that team's write permission", async (issueType) => {
    const { status, err } = await create({
      issueType,
      permissions: ["issues:read", "issues:write", TEAM_WRITE[issueType]],
    });
    expect(err).toBeUndefined();
    expect(status).toBe(201);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it.each(ISSUE_TYPES)(
    "denies %s for an REO-like caller holding base issues:read/write and templates only (no team write)",
    async (issueType) => {
      const { status } = await create({
        issueType,
        permissions: ["issues:read", "issues:write", "issues-templates:read", "issues-templates:write"],
      });
      expect(status).toBe(403);
      expect(saveSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["UNKNOWN", "complaint", "", undefined, "constructor", "__proto__"])(
    "rejects unknown issueType %p with 400 (never a pass), even for a wildcard caller",
    async (issueType) => {
      const { status } = await create({ issueType, permissions: ["*"] });
      expect(status).toBe(400);
      expect(saveSpy).not.toHaveBeenCalled();
    },
  );

  it.each(ISSUE_TYPES)("keeps ASU / wildcard (\"*\") able to create %s", async (issueType) => {
    const { status } = await create({ issueType, permissions: ["*"] });
    expect(status).toBe(201);
  });

  it("denies a portal-shaped caller (portal:* permissions only) that reaches the CRM create path", async () => {
    const { status } = await create({
      issueType: "COMPLAINT",
      userType: "PORTAL",
      permissions: ["portal:read", "portal:write"],
    });
    expect(status).toBe(403);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("leaves the separate portal create handler in place (portal flow is not routed through createIssue)", () => {
    const issuePortalController = require("../controllers/issuePortal.controller");
    expect(typeof issuePortalController.portalCreateIssue).toBe("function");
    expect(issuePortalController.portalCreateIssue).not.toBe(issueController.createIssue);
  });
});

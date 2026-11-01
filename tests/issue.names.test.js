// Display-name hydration on CRM issue responses (services/issueNames.service.js, wired into
// controllers/issue.controller.js's listIssues / listMyIssues / searchIssues / getIssueById).
// profile-service and user-service clients are mocked; Issue.aggregate / findOne are spied
// (not jest.mock'd) for the same discriminator-registration reason as
// tests/issue.search.controller.test.js.

jest.mock("../services/profileService.client", () => ({
  lookupProfilesByIds: jest.fn(),
  searchProfiles: jest.fn(async () => []),
}));
jest.mock("../services/userService.client", () => ({
  lookupUserNames: jest.fn(),
}));

const Issue = require("../models/issue.model");
const issueController = require("../controllers/issue.controller");
const profileServiceClient = require("../services/profileService.client");
const userServiceClient = require("../services/userService.client");
const { hydrateIssueNames } = require("../services/issueNames.service");

const A = "tenant-a";
const ME = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const RESOLVER = "cccccccccccccccccccccccc";
const STAFF_SUBJECT = "dddddddddddddddddddddddd";
const P1 = "111111111111111111111111";
const P2 = "222222222222222222222222";
const P_UNKNOWN = "999999999999999999999999";
const ALL_READ = [
  "issues-complaints:read",
  "issues-ftp:read",
  "issues-ir:read",
  "issues-dataprotection:read",
];

const complaint = {
  _id: "c1",
  tenantId: A,
  issueType: "COMPLAINT",
  priority: "HIGH",
  memberIds: [P1, P2],
  createdBy: ME,
  owner: { team: "COMPLAINTS", userId: OWNER },
  resolvedByUserId: RESOLVER,
  complaintAgainstUserId: STAFF_SUBJECT,
};
const ir = {
  _id: "i1",
  tenantId: A,
  issueType: "IR",
  priority: "MEDIUM",
  memberIds: [P_UNKNOWN],
  createdBy: "not-an-object-id",
  owner: { team: "IR", userId: null },
};

function mockLookups() {
  profileServiceClient.lookupProfilesByIds.mockResolvedValue([
    { _id: P1, membershipNumber: "M001", personalInfo: { fullName: "Mary Smith" } },
    { _id: P2, membershipNumber: "M002", personalInfo: { forename: "Tom", surname: "Jones" } },
  ]);
  userServiceClient.lookupUserNames.mockResolvedValue([
    { _id: ME, fullName: "Kate Creator", email: "kate@x" },
    { _id: OWNER, fullName: "Olly Owner", email: "olly@x" },
    { _id: RESOLVER, fullName: null, email: "rita@x" },
    { _id: STAFF_SUBJECT, fullName: "Sam Staff", email: "sam@x" },
  ]);
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const makeReq = (extra = {}) => ({
  query: {},
  params: {},
  headers: { authorization: "Bearer t" },
  ctx: { tenantId: A, userId: "someone-else", permissions: ALL_READ },
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLookups();
});

describe("hydrateIssueNames", () => {
  it("adds member, complainant, complained-against and user names without touching ids", async () => {
    const [c, i] = await hydrateIssueNames([complaint, ir], { req: makeReq(), tenantId: A });

    expect(c.memberIds).toEqual([P1, P2]);
    expect(c.createdBy).toBe(ME);
    expect(c.owner).toEqual({ team: "COMPLAINTS", userId: OWNER });
    expect(c.members).toEqual([
      { profileId: P1, fullName: "Mary Smith", membershipNumber: "M001" },
      { profileId: P2, fullName: "Tom Jones", membershipNumber: "M002" },
    ]);
    expect(c.memberNames).toEqual(["Mary Smith", "Tom Jones"]);
    expect(c.complainantName).toBe("Mary Smith");
    expect(c.complaintAgainstName).toBe("Tom Jones");
    expect(c.complaintAgainstUserName).toBe("Sam Staff");
    expect(c.createdByName).toBe("Kate Creator");
    expect(c.ownerName).toBe("Olly Owner");
    // No fullName on the user record -> null; email is never used as a display name.
    expect(c.resolvedByName).toBeNull();

    expect(i.members).toEqual([{ profileId: P_UNKNOWN, fullName: null, membershipNumber: null }]);
    expect(i.createdByName).toBeNull();
    expect(i.ownerName).toBeNull();
    expect(i).not.toHaveProperty("complainantName");
  });

  it("makes one batch call per service with deduped, valid ids and forwards req/tenant", async () => {
    const req = makeReq();
    await hydrateIssueNames([complaint, { ...complaint, _id: "c2" }, ir], { req, tenantId: A });
    expect(profileServiceClient.lookupProfilesByIds).toHaveBeenCalledTimes(1);
    expect(profileServiceClient.lookupProfilesByIds.mock.calls[0][0].sort()).toEqual(
      [P1, P2, P_UNKNOWN].sort(),
    );
    expect(profileServiceClient.lookupProfilesByIds.mock.calls[0][1]).toEqual({ req, tenantId: A });
    expect(userServiceClient.lookupUserNames).toHaveBeenCalledTimes(1);
    expect(userServiceClient.lookupUserNames.mock.calls[0][0].sort()).toEqual(
      [ME, OWNER, RESOLVER, STAFF_SUBJECT].sort(),
    );
  });

  it("degrades to null names (ids intact) when lookups fail", async () => {
    profileServiceClient.lookupProfilesByIds.mockRejectedValue(new Error("down"));
    userServiceClient.lookupUserNames.mockResolvedValue([]);
    const [c] = await hydrateIssueNames([complaint], { req: makeReq(), tenantId: A });
    expect(c.memberIds).toEqual([P1, P2]);
    expect(c.memberNames).toEqual([null, null]);
    expect(c.complainantName).toBeNull();
    expect(c.createdByName).toBeNull();
    expect(c.createdBy).toBe(ME);
  });

  it("never uses or exposes an email, even if a lookup returned one", async () => {
    const out = await hydrateIssueNames([complaint], { req: makeReq(), tenantId: A });
    expect(JSON.stringify(out)).not.toMatch(/@x/);
  });

  it("partial failure: user lookup down -> member names still resolved, user names null, ids intact", async () => {
    userServiceClient.lookupUserNames.mockRejectedValue(new Error("timeout"));
    const [c] = await hydrateIssueNames([complaint], { req: makeReq(), tenantId: A });
    expect(c.memberNames).toEqual(["Mary Smith", "Tom Jones"]);
    expect([c.createdByName, c.ownerName, c.resolvedByName, c.complaintAgainstUserName]).toEqual([null, null, null, null]);
    expect([c.createdBy, c.owner.userId, c.resolvedByUserId, c.complaintAgainstUserId]).toEqual([ME, OWNER, RESOLVER, STAFF_SUBJECT]);
  });

  it("preserves issue and member order regardless of lookup response order", async () => {
    profileServiceClient.lookupProfilesByIds.mockResolvedValue([
      { _id: P1, personalInfo: { fullName: "Mary Smith" } },
      { _id: P2, personalInfo: { fullName: "Tom Jones" } },
    ]);
    const reversed = { ...complaint, _id: "c9", memberIds: [P2, P1] };
    const out = await hydrateIssueNames([reversed, complaint], { req: makeReq(), tenantId: A });
    expect(out.map((x) => x._id)).toEqual(["c9", "c1"]);
    expect(out[0].memberNames).toEqual(["Tom Jones", "Mary Smith"]);
    expect(out[0].complainantName).toBe("Tom Jones");
  });

  it("makes no calls when there is nothing to resolve", async () => {
    await hydrateIssueNames([{ _id: "x", issueType: "FTP", memberIds: [] }], { tenantId: A });
    expect(profileServiceClient.lookupProfilesByIds).not.toHaveBeenCalled();
    expect(userServiceClient.lookupUserNames).not.toHaveBeenCalled();
  });
});

describe("issue.controller responses carry names", () => {
  let aggregateSpy;
  let countSpy;
  let findOneSpy;

  beforeEach(() => {
    aggregateSpy = jest.spyOn(Issue, "aggregate").mockResolvedValue([complaint, ir]);
    countSpy = jest.spyOn(Issue, "countDocuments").mockResolvedValue(2);
    findOneSpy = jest
      .spyOn(Issue, "findOne")
      .mockResolvedValue({ toObject: () => ({ ...complaint }) });
  });

  afterEach(() => {
    aggregateSpy.mockRestore();
    countSpy.mockRestore();
    findOneSpy.mockRestore();
  });

  it.each([
    ["listIssues", {}],
    ["listMyIssues", {}],
    ["searchIssues", { query: { q: "M001" } }],
  ])("%s", async (handler, reqExtra) => {
    const res = makeRes();
    const next = jest.fn();
    await issueController[handler](makeReq(reqExtra), res, next);
    expect(next).not.toHaveBeenCalled();
    const { data } = res.json.mock.calls[0][0];
    expect(data[0]).toMatchObject({
      _id: "c1",
      complainantName: "Mary Smith",
      complaintAgainstName: "Tom Jones",
      createdByName: "Kate Creator",
      ownerName: "Olly Owner",
    });
  });

  it("visibility first: an issue the caller cannot see (no match in the tenant/visibility filter) -> 404 and no name lookup", async () => {
    findOneSpy.mockResolvedValue(null);
    const next = jest.fn();
    await issueController.getIssueById(makeReq({ params: { id: "c1" } }), makeRes(), next);
    expect(next.mock.calls[0][0].status || next.mock.calls[0][0].statusCode).toBe(404);
    expect(profileServiceClient.lookupProfilesByIds).not.toHaveBeenCalled();
    expect(userServiceClient.lookupUserNames).not.toHaveBeenCalled();
  });

  it("getIssueById", async () => {
    const res = makeRes();
    const next = jest.fn();
    await issueController.getIssueById(makeReq({ params: { id: "c1" } }), res, next);
    expect(next).not.toHaveBeenCalled();
    const { data } = res.json.mock.calls[0][0];
    expect(data).toMatchObject({
      _id: "c1",
      memberIds: [P1, P2],
      memberNames: ["Mary Smith", "Tom Jones"],
      createdByName: "Kate Creator",
      ownerName: "Olly Owner",
      resolvedByName: null,
    });
  });
});

describe("issue routes: permission check runs before the controller (and so before enrichment)", () => {
  it("every enriched read route is behind requirePermission", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../routes/issue.routes.js"), "utf8");
    for (const [path, handler] of [["/", "listIssues"], ["/mine", "listMyIssues"], ["/:id", "getIssueById"]]) {
      const re = new RegExp(`router\\.get\\(\\s*"${path.replace("/", "\\/")}",[\\s\\S]*?requirePermission\\([^)]*\\)[\\s\\S]*?issueController\\.${handler}`);
      expect(src).toMatch(re);
    }
  });
});

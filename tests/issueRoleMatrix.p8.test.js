// P8 per-role issue authorization matrix (user-service #39 P8 draft role sets). Every case route needs
// the base issues:read / issues:write AND, per case type, the team issues-<team>:read (visibility) /
// issues-<team>:write (create since 7b3411f, update, status, delete). For each proposed role token this
// pins create / list / detail / update to the role's own team types (other types: create 403,
// detail / update 404 and never written). Persistence is stubbed; Issue.findOne / aggregate honour the
// controller's own filter, so the scoping under test is the controller's.
//
// IRO is NOT given base codes in the P8 draft: "own" (cases assigned to the caller, owner.userId) is
// enforced only on GET /issues/mine. The last block pins that gap (list / detail / update are not
// owner-scoped) so a fix has to change these expectations deliberately.
jest.mock("../services/history.service", () => ({ recordHistory: jest.fn(), summarizeObjectDiff: jest.fn(() => null) }));
jest.mock("../services/issueNames.service", () => ({ hydrateIssueNames: jest.fn(async (rows) => rows) }));
jest.mock("../rabbitMQ/publishers/issue.events.publisher.js", () => new Proxy({}, { get: () => jest.fn(async () => {}) }));

const mongoose = require("mongoose");
const Issue = require("../models/issue.model");
const issueController = require("../controllers/issue.controller");
const issueService = require("../services/issue.service");

const TYPES = ["COMPLAINT", "FTP", "IR", "DP"];
const TEAM = { COMPLAINT: "issues-complaints", FTP: "issues-ftp", IR: "issues-ir", DP: "issues-dataprotection" };
const BASE = ["issues:read", "issues:write"];
const team = (...types) => types.flatMap((t) => [`${TEAM[t]}:read`, `${TEAM[t]}:write`]);
// Proposed tokens: base grants + the role's #39 team codes (IRO WITHOUT base = today, and WITH base for the exposure check).
const ROLES = {
  MO: [...BASE, "issues-templates:read", ...team("COMPLAINT")],
  IO: [...BASE, ...team("COMPLAINT", "IR")],
  IRE: [...BASE, ...team("FTP", "IR")],
  ADIR: [...BASE, ...team("FTP", "IR")],
  DIR: [...BASE, ...team("FTP", "IR")],
  AMO: [...BASE, ...team("COMPLAINT")],
  DPO: [...BASE, ...team("DP")],
  REO23: ["issues:read", "issues-templates:read"],
  IRO_with_base: [...BASE, ...team("COMPLAINT", "FTP", "IR")],
};
const ALLOWED = { MO: ["COMPLAINT"], IO: ["COMPLAINT", "IR"], IRE: ["FTP", "IR"], ADIR: ["FTP", "IR"], DIR: ["FTP", "IR"], AMO: ["COMPLAINT"], DPO: ["DP"], REO23: [], IRO_with_base: ["COMPLAINT", "FTP", "IR"] };

const CALLER = "user-caller";
const OTHER = "user-other";
const docs = TYPES.flatMap((t) => [OTHER, CALLER].map((owner, i) => ({ _id: `${t}-${i}`, tenantId: "tenant-a", issueType: t, owner: { userId: owner }, complaintAgainstUserId: null, meta: {} })));

function matches(doc, f) {
  if (f.tenantId && doc.tenantId !== f.tenantId) return false;
  if (f._id && doc._id !== f._id) return false;
  const it = f.issueType;
  if (it && typeof it === "object" && it.$in && !it.$in.includes(doc.issueType)) return false;
  if (typeof it === "string" && doc.issueType !== it) return false;
  if (f["owner.userId"] !== undefined && doc.owner.userId !== f["owner.userId"]) return false;
  return true;
}
const asDoc = (d) => ({ ...d, toObject: () => ({ ...d }), save: jest.fn(async () => {}) });
let lastFilters = [];
beforeEach(() => {
  lastFilters = [];
  jest.spyOn(Issue, "findOne").mockImplementation(async (f) => { lastFilters.push(f); const d = docs.find((x) => matches(x, f)); return d ? asDoc(d) : null; });
  jest.spyOn(Issue, "aggregate").mockImplementation(async (stages) => { const f = stages[0].$match; lastFilters.push(f); return docs.filter((x) => matches(x, f)); });
  jest.spyOn(mongoose.Model.prototype, "save").mockImplementation(function () { return Promise.resolve(this); });
  jest.spyOn(issueService, "prepareNewIssue").mockResolvedValue();
  jest.spyOn(issueService, "publishIssueCreatedEvents").mockResolvedValue();
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const req = (permissions, extra = {}) => ({ body: {}, query: {}, params: {}, ctx: { tenantId: "tenant-a", userId: CALLER, userType: "CRM", permissions }, user: { email: "a.b@example.test" }, headers: {}, ...extra });
async function call(fn, r) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }; const next = jest.fn();
  await fn(r, res, next); const err = next.mock.calls[0]?.[0];
  return { status: err ? err.status : res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

describe.each(Object.keys(ROLES))("%s", (role) => {
  const perms = ROLES[role]; const allowed = ALLOWED[role];
  test.each(TYPES)("create %s: allowed only for the role's team", async (t) => {
    const r = await call(issueController.createIssue, req(perms, { body: { issueType: t, memberIds: [] } }));
    expect(r.status).toBe(allowed.includes(t) ? 201 : 403);
  });
  test("list returns only the role's team types", async () => {
    const r = await call(issueController.listIssues, req(perms));
    expect([...new Set(r.body.data.map((d) => d.issueType))].sort()).toEqual([...allowed].sort());
  });
  test.each(TYPES)("detail %s: visible only for the role's team (else 404)", async (t) => {
    const r = await call(issueController.getIssueById, req(perms, { params: { id: `${t}-0` } }));
    expect(r.status).toBe(allowed.includes(t) ? 200 : 404);
  });
  test.each(TYPES)("update %s: only the role's team (else 404, never written)", async (t) => {
    const r = await call(issueController.updateIssue, req(perms, { params: { id: `${t}-0` }, body: { caseTitle: "x" } }));
    expect(r.status).toBe(allowed.includes(t) ? 200 : 404);
  });
});

describe("KNOWN GAP (IRO stays without base codes): 'own' = cases assigned to the caller (owner.userId) is not enforced on list / detail / update", () => {
  const perms = ROLES.IRO_with_base;
  test("list /issues: NOT restricted to assigned cases (other owners' cases returned)", async () => {
    const r = await call(issueController.listIssues, req(perms));
    expect(r.body.data.some((d) => d.owner.userId === OTHER)).toBe(true);
    expect(lastFilters[0]).not.toHaveProperty(["owner.userId"]);
  });
  test("detail /issues/:id: NOT restricted (another owner's case is 200)", async () => {
    expect((await call(issueController.getIssueById, req(perms, { params: { id: "FTP-0" } }))).status).toBe(200);
  });
  test("update PUT /issues/:id: NOT restricted (another owner's case is updated)", async () => {
    expect((await call(issueController.updateIssue, req(perms, { params: { id: "IR-0" }, body: { caseTitle: "x" } }))).status).toBe(200);
  });
});

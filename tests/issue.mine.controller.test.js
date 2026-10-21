// GET /issues/mine (controllers/issue.controller.js#listMyIssues) - the caller's created /
// assigned cases. Issue.aggregate / Issue.countDocuments are spied with a tiny in-memory
// matcher over seeded rows (tenant A and tenant B), so the tenant / user / team / complaint-hide
// scoping is exercised behaviourally rather than only by asserting on the $match shape.
// Spied rather than jest.mock'd for the same discriminator-registration reason as
// tests/issue.search.controller.test.js.

const Issue = require("../models/issue.model");
const issueController = require("../controllers/issue.controller");

const A = "tenant-a";
const B = "tenant-b";
const ME = "user-me";
const COLLEAGUE = "user-colleague";
const ALL_READ = [
  "issues-complaints:read",
  "issues-ftp:read",
  "issues-ir:read",
  "issues-dataprotection:read",
];

function get(doc, path) {
  return path.split(".").reduce((cur, key) => (cur == null ? undefined : cur[key]), doc);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(doc, f));
    const value = get(doc, key);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === "$ne") return value !== arg;
        if (op === "$in") return arg.includes(value);
        throw new Error(`unsupported operator ${op}`);
      });
    }
    return value === cond;
  });
}

const row = (id, overrides) => ({
  _id: id,
  tenantId: A,
  issueType: "IR",
  issueStatus: "ACTIVE-IR",
  priority: "MEDIUM",
  createdBy: COLLEAGUE,
  owner: { userId: COLLEAGUE },
  complaintAgainstUserId: null,
  meta: { deleted: false },
  createdOn: new Date("2026-10-01"),
  ...overrides,
});

const ROWS = [
  row("created-by-me", { createdBy: ME }),
  row("assigned-to-me", { owner: { userId: ME } }),
  row("both", { createdBy: ME, owner: { userId: ME } }),
  row("closed-mine", { createdBy: ME, issueStatus: "CLOSED" }),
  row("colleague-only"),
  row("deleted-mine", { createdBy: ME, meta: { deleted: true } }),
  row("dp-mine", { createdBy: ME, issueType: "DP", issueStatus: "ACTIVE-DP" }),
  row("complaint-about-me", { issueType: "COMPLAINT", issueStatus: "ACTIVE", owner: { userId: ME }, complaintAgainstUserId: ME }),
  // Same user id in another tenant - must never appear.
  row("tenant-b-created", { tenantId: B, createdBy: ME }),
  row("tenant-b-assigned", { tenantId: B, owner: { userId: ME } }),
];

function makeReq({ query = {}, permissions = ALL_READ, tenantId = A, userId = ME } = {}) {
  return { query, ctx: { tenantId, userId, permissions } };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function run(reqOptions) {
  const res = makeRes();
  const next = jest.fn();
  await issueController.listMyIssues(makeReq(reqOptions), res, next);
  const body = res.json.mock.calls[0]?.[0];
  return { body, next, ids: body ? body.data.map((d) => d._id).sort() : null };
}

describe("issue.controller listMyIssues", () => {
  let aggregateSpy;
  let countSpy;

  beforeEach(() => {
    aggregateSpy = jest.spyOn(Issue, "aggregate").mockImplementation(async (pipeline) => {
      const match = pipeline[0].$match;
      const skip = pipeline.find((s) => s.$skip !== undefined)?.$skip || 0;
      const limit = pipeline.find((s) => s.$limit !== undefined)?.$limit || Infinity;
      return ROWS.filter((r) => matches(r, match)).slice(skip, skip + limit);
    });
    countSpy = jest
      .spyOn(Issue, "countDocuments")
      .mockImplementation(async (filter) => ROWS.filter((r) => matches(r, filter)).length);
  });

  afterEach(() => {
    aggregateSpy.mockRestore();
    countSpy.mockRestore();
  });

  it("scope=all returns created-or-assigned cases in the caller's tenant only", async () => {
    const { ids, body } = await run();
    expect(ids).toEqual(["assigned-to-me", "both", "closed-mine", "created-by-me", "dp-mine"].sort());
    expect(body.meta).toMatchObject({ scope: "all", total: 5 });
  });

  it("scope=created and scope=assigned split the list", async () => {
    expect((await run({ query: { scope: "created" } })).ids).toEqual(
      ["both", "closed-mine", "created-by-me", "dp-mine"].sort(),
    );
    expect((await run({ query: { scope: "assigned" } })).ids).toEqual(["assigned-to-me", "both"]);
  });

  it("never returns another tenant's cases, even for the same user id", async () => {
    const { ids } = await run();
    expect(ids).not.toContain("tenant-b-created");
    expect(ids).not.toContain("tenant-b-assigned");
    const tenantB = await run({ tenantId: B });
    expect(tenantB.ids).toEqual(["tenant-b-assigned", "tenant-b-created"]);
    for (const [filter] of countSpy.mock.calls) expect(filter.tenantId).toBeDefined();
  });

  it("ignores userId / tenantId / createdBy supplied in the query", async () => {
    const { ids } = await run({
      query: { userId: COLLEAGUE, tenantId: B, createdBy: COLLEAGUE, "owner.userId": COLLEAGUE },
    });
    expect(ids).not.toContain("colleague-only");
    expect(ids).not.toContain("tenant-b-created");
    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(match.tenantId).toBe(A);
    expect(match.$or).toEqual([{ createdBy: ME }, { "owner.userId": ME }]);
  });

  it("keeps team visibility: without DP read, DP cases are hidden", async () => {
    const { ids } = await run({ permissions: ["issues-ir:read", "issues-complaints:read"] });
    expect(ids).not.toContain("dp-mine");
  });

  it("keeps complaint-hide: a complaint about the caller is hidden even when assigned to them", async () => {
    const { ids } = await run({ query: { scope: "assigned" } });
    expect(ids).not.toContain("complaint-about-me");
  });

  it("excludes soft-deleted cases", async () => {
    expect((await run()).ids).not.toContain("deleted-mine");
  });

  it("state=open / state=closed filter on CLOSED", async () => {
    expect((await run({ query: { state: "closed" } })).ids).toEqual(["closed-mine"]);
    expect((await run({ query: { state: "open" } })).ids).not.toContain("closed-mine");
  });

  it("reports open created/assigned counts for badges", async () => {
    const { body } = await run({ query: { scope: "assigned" } });
    expect(body.meta.openCounts).toEqual({ created: 3, assigned: 2 });
  });

  it("paginates with a capped limit", async () => {
    const { body, ids } = await run({ query: { page: "2", limit: "2" } });
    expect(ids).toHaveLength(2);
    expect(body.meta).toMatchObject({ page: 2, limit: 2, total: 5 });
    const capped = await run({ query: { limit: "5000" } });
    expect(capped.body.meta.limit).toBe(100);
  });

  it("stringifies operator objects smuggled through the query string", async () => {
    await run({ query: { priority: { $ne: "x" }, issueStatus: { $ne: "x" } } });
    const match = aggregateSpy.mock.calls[0][0][0].$match;
    expect(typeof match.priority).toBe("string");
    expect(typeof match.issueStatus).toBe("string");
  });

  it.each([
    ["an unknown scope", { query: { scope: "everyone" } }],
    ["an unknown state", { query: { state: "pending" } }],
  ])("400s on %s", async (_label, opts) => {
    const { next } = await run(opts);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(aggregateSpy).not.toHaveBeenCalled();
  });

  it("401s without a user in the trusted context", async () => {
    const { next } = await run({ userId: null });
    expect(next.mock.calls[0][0].status).toBe(401);
  });
});

describe("issue.routes /mine registration", () => {
  it("registers GET /mine before GET /:id", () => {
    const issueRouter = require("../routes/issue.routes");
    const paths = issueRouter.stack
      .filter((layer) => layer.route && layer.route.methods.get)
      .map((layer) => layer.route.path);
    expect(paths.indexOf("/mine")).toBeGreaterThan(-1);
    expect(paths.indexOf("/mine")).toBeLessThan(paths.indexOf("/:id"));
  });
});

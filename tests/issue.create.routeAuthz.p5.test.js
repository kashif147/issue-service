// POST /api/issues through the REAL route wiring (middlewares/auth.js authenticate ->
// tenantContextWarn -> routes/issue.routes.js requirePermission("issues","write") ->
// issue.controller createIssue). Only the PDP round trip (policyClient.evaluateWithHeaders,
// which in production calls user-service /policy/evaluate) is replaced by a stand-in that
// PERMITs exactly when the forwarded permissions hold the requested resource:action (or "*").
// Persistence, numbering and events are stubbed so only authorization and tenant scoping
// are exercised. Synthetic ids only.

jest.mock("../services/history.service", () => ({
  recordHistory: jest.fn(),
  summarizeObjectDiff: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { authenticate } = require("../middlewares/auth");
const { tenantContextWarn } = require("../middlewares/tenantContext.mw");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
const issueService = require("../services/issue.service");

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const USER = "c00000000000000000000001";

let saved;
let pdpCalls;
let prevBypass;

function buildApp(tenantGuard = tenantContextWarn) {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use(tenantGuard);
  app.use("/api/issues", require("../routes/issue.routes"));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function gatewayHeaders(permissions, tenantId = TENANT_A) {
  return {
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": USER,
    "x-tenant-id": tenantId,
    "x-user-type": "CRM",
    "x-user-email": "first.last@example.test",
    "x-user-roles": "[]",
    "x-user-permissions": JSON.stringify(permissions),
  };
}

beforeAll(() => {
  prevBypass = process.env.AUTH_BYPASS_ENABLED;
  process.env.AUTH_BYPASS_ENABLED = "false";
});
afterAll(() => {
  process.env.AUTH_BYPASS_ENABLED = prevBypass;
});

beforeEach(() => {
  saved = [];
  pdpCalls = [];
  jest
    .spyOn(defaultPolicyMiddleware.policyClient, "evaluateWithHeaders")
    .mockImplementation(async (headers, resource, action, context) => {
      pdpCalls.push({ resource, action, tenantId: context.tenantId });
      const perms = JSON.parse(headers["x-user-permissions"] || "[]");
      const ok = perms.includes("*") || perms.includes(`${resource}:${action}`);
      return ok
        ? { success: true, decision: "PERMIT", user: { id: USER, tenantId: context.tenantId, userType: "CRM" } }
        : { success: true, decision: "DENY", reason: "MISSING_PERMISSION" };
    });
  jest.spyOn(mongoose.Model.prototype, "save").mockImplementation(function save() {
    saved.push(this.toObject());
    return Promise.resolve(this);
  });
  jest.spyOn(issueService, "prepareNewIssue").mockResolvedValue();
  jest.spyOn(issueService, "publishIssueCreatedEvents").mockResolvedValue();
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/issues route floor: base issues:write", () => {
  test("team write alone, without base issues:write -> 403 at the route, controller never runs", async () => {
    const res = await request(buildApp())
      .post("/api/issues")
      .set(gatewayHeaders(["issues:read", "issues-complaints:write"]))
      .send({ issueType: "COMPLAINT", memberIds: [] });
    expect(res.status).toBe(403);
    expect(pdpCalls).toEqual([{ resource: "issues", action: "write", tenantId: TENANT_A }]);
    expect(saved).toHaveLength(0);
  });

  test("base issues:write is what the route asks the PDP for", async () => {
    await request(buildApp())
      .post("/api/issues")
      .set(gatewayHeaders(["issues:write", "issues-complaints:write"]))
      .send({ issueType: "COMPLAINT", memberIds: [] });
    expect(pdpCalls.map((c) => `${c.resource}:${c.action}`)).toEqual(["issues:write"]);
  });

  test("no gateway identity -> 401/400, nothing saved", async () => {
    const res = await request(buildApp()).post("/api/issues").send({ issueType: "COMPLAINT" });
    expect([400, 401]).toContain(res.status);
    expect(saved).toHaveLength(0);
  });
});

describe("POST /api/issues exact team write (behind the route floor)", () => {
  test.each([
    ["COMPLAINT", "issues-ftp:write"],
    ["FTP", "issues-complaints:write"],
    ["IR", "issues-ir:read"],
    ["DP", "issues-ftp:write"],
  ])("%s with base write but only %s -> 403, nothing saved", async (issueType, teamPerm) => {
    const res = await request(buildApp())
      .post("/api/issues")
      .set(gatewayHeaders(["issues:write", teamPerm]))
      .send({ issueType, memberIds: [] });
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  test("unknown issueType -> 400 even with every permission", async () => {
    const res = await request(buildApp())
      .post("/api/issues")
      .set(gatewayHeaders(["*"]))
      .send({ issueType: "__proto__", memberIds: [] });
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });
});

describe("POST /api/issues tenant scoping", () => {
  test("authorized same-tenant creation succeeds under the verified tenant", async () => {
    const res = await request(buildApp())
      .post("/api/issues")
      .set(gatewayHeaders(["issues:write", "issues-complaints:write"]))
      .send({ issueType: "COMPLAINT", memberIds: [] });
    expect(res.status).toBe(201);
    expect(saved).toHaveLength(1);
    expect(String(saved[0].tenantId)).toBe(TENANT_A);
    expect(String(saved[0].createdBy)).toBe(USER);
  });

  test.each([
    ["body", { tenantId: TENANT_B }, ""],
    ["query", {}, `?tenantId=${TENANT_B}`],
  ])("caller-supplied %s tenantId never changes the tenant (rejected or created under the verified tenant)", async (_l, extra, qs) => {
    const res = await request(buildApp())
      .post(`/api/issues${qs}`)
      .set(gatewayHeaders(["issues:write", "issues-complaints:write"]))
      .send({ issueType: "COMPLAINT", memberIds: [], ...extra });
    expect(pdpCalls.every((c) => c.tenantId === TENANT_A)).toBe(true);
    if (res.status === 201) {
      expect(saved).toHaveLength(1);
      expect(String(saved[0].tenantId)).toBe(TENANT_A);
    } else {
      expect(res.status).toBe(403);
      expect(saved).toHaveLength(0);
    }
    expect(saved.some((s) => String(s.tenantId) === TENANT_B)).toBe(false);
  });

  test("ENFORCE mode (as DEV runs) rejects a mismatching body tenantId before the handler", async () => {
    // The mode is read when middlewares/tenantContext.mw.js is loaded, so load a fresh copy.
    const prev = process.env.TENANT_CONTEXT_MODE;
    process.env.TENANT_CONTEXT_MODE = "enforce";
    try {
      let enforceGuard;
      jest.isolateModules(() => {
        enforceGuard = require("../middlewares/tenantContext.mw").tenantContextWarn;
      });
      const res = await request(buildApp(enforceGuard))
        .post("/api/issues")
        .set(gatewayHeaders(["issues:write", "issues-complaints:write"]))
        .send({ issueType: "COMPLAINT", memberIds: [], tenantId: TENANT_B });
      expect(res.status).toBe(403);
      expect(saved).toHaveLength(0);
    } finally {
      process.env.TENANT_CONTEXT_MODE = prev;
    }
  });
});

// PDP rollout P2 (b), issue-service, through the REAL route wiring (middlewares/auth.js authenticate ->
// tenantContextWarn -> routes/index.js -> routes):
//   Q1  IRO/PA assignment writes (POST /, PUT /:id, DELETE /:id) need issues:write AND issues-ir:write;
//       GET keeps issues:read only.
//   Q8  every /issues/portal/* route is PORTAL-only (middlewares/portalOnly.mw.js requirePortalUser),
//       registered before the portal routes, so a CRM token is refused even when it holds portal:*.
// Only the PDP round trip (policyClient.evaluateWithHeaders) is replaced by a stand-in that PERMITs
// exactly when the forwarded permissions hold resource:action (or "*") and records every (resource,
// action) it was asked. Controllers are stubs that answer 200 with their own name. Synthetic ids only.

jest.mock("../controllers/iroPaAssignment.controller.js", () => {
  const stub = (name) => (req, res) => res.status(200).json({ handler: name });
  return { list: stub("list"), create: stub("create"), update: stub("update"), remove: stub("remove") };
});
jest.mock("../controllers/issuePortal.controller.js", () => {
  const names = [
    "portalCreateIssue",
    "portalListMyIssues",
    "portalGetMyIssueById",
    "portalListMyIssueActivities",
    "portalGetMyIssueHistory",
    "portalAddIssueComment",
    "portalUploadAttachments",
    "portalUpdateComment",
    "portalDeleteComment",
    "portalRemoveAttachment",
    "portalDownloadAttachment",
  ];
  return Object.fromEntries(names.map((n) => [n, (req, res) => res.status(200).json({ handler: n })]));
});

const express = require("express");
const request = require("supertest");
const { authenticate } = require("../middlewares/auth");
const { tenantContextWarn } = require("../middlewares/tenantContext.mw");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
const { errorHandler } = require("../middlewares/response.mw");
const { requirePortalUser } = require("../middlewares/portalOnly.mw");

const TENANT = "aaaaaaaaaaaaaaaaaaaaaaaa";
const USER = "c00000000000000000000001";
const ID = "d00000000000000000000001";
const ACT = "e00000000000000000000001";

let pdpCalls;
let prevBypass;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use(tenantContextWarn);
  app.use("/api", require("../routes/index"));
  app.use(errorHandler);
  return app;
}

function headers(permissions, userType = "CRM") {
  const h = {
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": USER,
    "x-tenant-id": TENANT,
    "x-user-email": "first.last@example.test",
    "x-user-roles": "[]",
    "x-user-permissions": JSON.stringify(permissions),
  };
  if (userType !== undefined) h["x-user-type"] = userType;
  return h;
}

const send = (method, path, h) => {
  const r = request(buildApp())[method](path).set(h);
  return method === "get" || method === "delete" ? r : r.send({});
};

beforeAll(() => {
  prevBypass = process.env.AUTH_BYPASS_ENABLED;
  process.env.AUTH_BYPASS_ENABLED = "false";
});
afterAll(() => {
  process.env.AUTH_BYPASS_ENABLED = prevBypass;
});
beforeEach(() => {
  pdpCalls = [];
  jest
    .spyOn(defaultPolicyMiddleware.policyClient, "evaluateWithHeaders")
    .mockImplementation(async (h, resource, action, context) => {
      pdpCalls.push(`${resource}:${action}`);
      const perms = JSON.parse(h["x-user-permissions"] || "[]");
      const ok = perms.includes("*") || perms.includes(`${resource}:${action}`);
      return ok
        ? { success: true, decision: "PERMIT", user: { id: USER, tenantId: context.tenantId, userType: h["x-user-type"] } }
        : { success: true, decision: "DENY", reason: "MISSING_PERMISSION" };
    });
});
afterEach(() => jest.restoreAllMocks());

describe("Q1: IRO/PA assignment writes require issues-ir:write on top of issues:write", () => {
  const WRITES = [
    ["post", "/api/iro-pa-assignments", "create"],
    ["put", `/api/iro-pa-assignments/${ID}`, "update"],
    ["delete", `/api/iro-pa-assignments/${ID}`, "remove"],
  ];

  test.each(WRITES)("%s %s: MO-like CRM (issues:write, no issues-ir:write) -> 403, controller not reached", async (m, p) => {
    const res = await send(m, p, headers(["issues:read", "issues:write", "issues-complaints:read", "issues-complaints:write"]));
    expect(res.status).toBe(403);
    expect(res.body.handler).toBeUndefined();
    expect(pdpCalls).toEqual(["issues:write", "issues-ir:write"]);
  });

  test.each(WRITES)("%s %s: issues:write + issues-ir:write -> reaches the controller", async (m, p, handler) => {
    const res = await send(m, p, headers(["issues:write", "issues-ir:write"]));
    expect(res.status).toBe(200);
    expect(res.body.handler).toBe(handler);
    expect(pdpCalls).toEqual(["issues:write", "issues-ir:write"]);
  });

  test.each(WRITES)("%s %s: issues-ir:write without the issues:write floor -> 403", async (m, p) => {
    const res = await send(m, p, headers(["issues-ir:write"]));
    expect(res.status).toBe(403);
    expect(pdpCalls).toEqual(["issues:write"]);
  });

  test.each(WRITES)("%s %s: ASU-style '*' -> reaches the controller", async (m, p, handler) => {
    const res = await send(m, p, headers(["*"]));
    expect(res.status).toBe(200);
    expect(res.body.handler).toBe(handler);
  });

  test("GET is unchanged: issues:read only, no team check", async () => {
    const res = await send("get", "/api/iro-pa-assignments", headers(["issues:read"]));
    expect(res.status).toBe(200);
    expect(res.body.handler).toBe("list");
    expect(pdpCalls).toEqual(["issues:read"]);
  });
});

describe("Q8: /issues/portal/* is PORTAL-only", () => {
  const PORTAL_ROUTES = [
    ["get", "/api/issues/portal/mine", "portalListMyIssues", "portal:read"],
    ["post", "/api/issues/portal", "portalCreateIssue", "portal:write"],
    ["get", `/api/issues/portal/${ID}`, "portalGetMyIssueById", "portal:read"],
    ["get", `/api/issues/portal/${ID}/activities`, "portalListMyIssueActivities", "portal:read"],
    ["get", `/api/issues/portal/${ID}/history`, "portalGetMyIssueHistory", "portal:read"],
    ["post", `/api/issues/portal/${ID}/activities`, "portalAddIssueComment", "portal:write"],
    ["post", `/api/issues/portal/${ID}/attachments`, "portalUploadAttachments", "portal:write"],
    ["put", `/api/issues/portal/${ID}/activities/${ACT}`, "portalUpdateComment", "portal:write"],
    ["delete", `/api/issues/portal/${ID}/activities/${ACT}`, "portalDeleteComment", "portal:write"],
    ["delete", `/api/issues/portal/${ID}/activities/${ACT}/attachments/0`, "portalRemoveAttachment", "portal:write"],
    ["get", `/api/issues/portal/${ID}/activities/${ACT}/attachments/0/download`, "portalDownloadAttachment", "portal:read"],
  ];

  test.each(PORTAL_ROUTES)("%s %s: CRM token holding portal:* and '*' -> 403 PORTAL_ONLY before the PDP", async (m, p) => {
    const res = await send(m, p, headers(["portal:read", "portal:write", "*"], "CRM"));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PORTAL_ONLY");
    expect(res.body.handler).toBeUndefined();
    expect(pdpCalls).toEqual([]);
  });

  test.each(PORTAL_ROUTES)("%s %s: PORTAL token with portal:read/write -> reaches %s", async (m, p, handler, perm) => {
    const res = await send(m, p, headers(["portal:read", "portal:write"], "PORTAL"));
    expect(res.status).toBe(200);
    expect(res.body.handler).toBe(handler);
    expect(pdpCalls).toEqual([perm]);
  });

  test.each(PORTAL_ROUTES)("%s %s: PORTAL token without the portal code -> 403 at the PDP", async (m, p) => {
    const res = await send(m, p, headers([], "PORTAL"));
    expect(res.status).toBe(403);
    expect(res.body.handler).toBeUndefined();
  });

  test.each([
    ["missing x-user-type", undefined],
    ["SYSTEM", "SYSTEM"],
    ["empty", ""],
  ])("%s -> 403 PORTAL_ONLY", async (_l, userType) => {
    const res = await send("get", "/api/issues/portal/mine", headers(["portal:read"], userType));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PORTAL_ONLY");
    expect(pdpCalls).toEqual([]);
  });

  test("CRM issue routes are not affected by the portal guard", async () => {
    const res = await send("get", "/api/issues/search", headers([], "CRM"));
    expect(res.status).toBe(403); // the PDP's issues:read denial, not PORTAL_ONLY
    expect(res.body.error && res.body.error.code).not.toBe("PORTAL_ONLY");
    expect(pdpCalls).toEqual(["issues:read"]);
  });
});

describe("requirePortalUser unit", () => {
  const run = (user) => {
    const next = jest.fn();
    requirePortalUser({ user }, {}, next);
    return next.mock.calls[0][0];
  };
  test("PORTAL (any case / whitespace) passes", () => {
    expect(run({ userType: "PORTAL" })).toBeUndefined();
    expect(run({ userType: " portal " })).toBeUndefined();
  });
  test.each([[undefined], [{}], [{ userType: "CRM" }], [{ userType: "MEMBER" }], [{ userType: 1 }]])("%j -> 403 PORTAL_ONLY", (user) => {
    const err = run(user);
    expect(err.status).toBe(403);
    expect(err.code).toBe("PORTAL_ONLY");
  });
});

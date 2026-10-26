// Phase A / A11 - issue-service lookup client resolves lookup types by stable code
// (GET /api/lookup/by-type-code/:code/hierarchy); no process-global code -> type-id cache.
// axios is stubbed (no network).
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const calls = [];
let respond;
axios.get = async (url, config) => {
  calls.push({ url, headers: (config && config.headers) || {} });
  return respond(url);
};

const client = require("../services/lookup.service.client");

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const D = "6ad4e0c941376f7df605fd57";

const item = (id, code, name, extra = {}) => ({ lookup: { _id: id, code, lookupname: name, DisplayName: name, ...extra }, hierarchy: [] });
const BODIES = {
  ISST: [item("65a0000000000000000000a1", "COMPLAINT", "Complaint"), item("65a0000000000000000000a2", "FTP", "FTP")],
  ISSUSTATUS: [
    item("65a0000000000000000000b1", "OPEN", "Open", { Parentlookupid: "65a0000000000000000000a1" }),
    item("65a0000000000000000000b2", "CLOSED", "Closed", { Parentlookupid: "65a0000000000000000000a2" }),
  ],
  ORIGIN: [item("65a0000000000000000000c1", "EMAIL", "Email")],
  WORKLOC: [item("65a0000000000000000000d1", "WL_BEAU", "Beaumont Hospital", { officer: { _id: "65a0000000000000000000e1" } })],
};
const byCodeResponder = (url) => {
  const m = url.match(/\/api\/lookup\/by-type-code\/([^/]+)\/hierarchy$/);
  if (m && BODIES[decodeURIComponent(m[1])]) {
    return { status: 200, data: { lookuptype: { code: m[1] }, totalCount: 1, results: BODIES[decodeURIComponent(m[1])] } };
  }
  return { status: 404, data: { error: { code: "LOOKUP_TYPE_NOT_FOUND" } } };
};
const reqFor = (tenantId) => ({ ctx: { tenantId }, headers: { "x-jwt-verified": "true", "x-user-type": "CRM", "x-correlation-id": "cid-9" } });

beforeEach(() => {
  calls.length = 0;
  respond = byCodeResponder;
});

test("resolves each lookup type by code with one call - never /api/lookuptype or by-type/<id>", async () => {
  const types = await client.fetchIssueTypes({ req: reqFor(A), tenantId: A });
  expect(types.map((t) => t.code)).toEqual(["COMPLAINT", "FTP"]);
  expect(calls.map((c) => c.url)).toEqual([expect.stringMatching(/\/api\/lookup\/by-type-code\/ISST\/hierarchy$/)]);
  expect(calls.some((c) => /\/api\/lookuptype|\/by-type\//.test(c.url))).toBe(false);
});

test("trusted tenant and identity headers are forwarded", async () => {
  await client.fetchOrigins({ req: reqFor(A), tenantId: A });
  expect(calls[0].headers["x-tenant-id"]).toBe(A);
  expect(calls[0].headers["x-user-type"]).toBe("CRM");
  expect(calls[0].headers["x-correlation-id"]).toBe("cid-9");
});

test("same code by MULTIAUTH, DEVTENANTB, DEVDIRB: one call each under its own tenant; nothing cached client-side", async () => {
  for (const t of [A, B, D, A]) await client.fetchIssueTypes({ req: reqFor(t), tenantId: t });
  expect(calls.map((c) => c.headers["x-tenant-id"])).toEqual([A, B, D, A]);
});

test("unknown code (404) -> [] (e.g. ISSUEDESG, which has no lookup type in DEV)", async () => {
  expect(await client.searchIssueDesignations("x", { req: reqFor(A), tenantId: A })).toEqual([]);
  expect(calls[0].url).toMatch(/\/by-type-code\/ISSUEDESG\/hierarchy$/);
});

test("issue-type-scoped options filter by the parent issue type's code", async () => {
  const statuses = await client.fetchIssueStatuses("complaint", { req: reqFor(A), tenantId: A });
  expect(statuses.map((s) => s.code)).toEqual(["OPEN"]);
  expect(calls.map((c) => c.url.match(/by-type-code\/([^/]+)/)[1]).sort()).toEqual(["ISST", "ISSUSTATUS"]);
});

test("IRO work-location resolution goes through WORKLOC by code", async () => {
  const wl = await client.findWorkLocationLookup("beaumont hospital", { req: reqFor(A), tenantId: A });
  expect(wl.officer).toEqual({ _id: "65a0000000000000000000e1" });
  expect(calls[0].url).toMatch(/\/by-type-code\/WORKLOC\/hierarchy$/);
});

test("network failure / 5xx degrade to [] without throwing", async () => {
  respond = () => {
    throw new Error("ECONNREFUSED");
  };
  expect(await client.fetchIssueTypes({ req: reqFor(A), tenantId: A })).toEqual([]);
});

test("missing / placeholder tenant fails closed: [] / null and no call", async () => {
  for (const t of [undefined, "", "default", "unknown"]) {
    expect(await client.fetchIssueTypes({ req: null, tenantId: t })).toEqual([]);
    expect(await client.findWorkLocationLookup("65a0000000000000000000d1", { req: null, tenantId: t })).toBeNull();
  }
  expect(calls).toEqual([]);
});

test("a tenant disagreeing with the request's trusted tenant fails closed: no call", async () => {
  expect(await client.fetchIssueTypes({ req: reqFor(A), tenantId: B })).toEqual([]);
  expect(calls).toEqual([]);
  expect(client.resolveLookupTenant(reqFor(A), A)).toBe(A);
});

test("no process-global lookup-type id cache remains in the source", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "lookup.service.client.js"), "utf8");
  expect(src).not.toMatch(/lookupTypeIdCache|getLookupTypeIdByCode|LOOKUP_TYPE_CACHE_TTL_MS/);
  expect(src).not.toContain("/api/lookuptype");
});

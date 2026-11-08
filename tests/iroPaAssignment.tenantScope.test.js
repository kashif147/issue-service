// PDP rollout P2 (Q1): the IRO/PA assignment guard moved to issues-ir:*; the controller's tenant scope is
// unchanged. Every query is bound to req.ctx.tenantId; a tenantId in the body or another tenant's row id
// cannot widen it. The model is replaced by a recorder; synthetic ids only.
const calls = [];
jest.mock("../models/iroPaAssignment.model", () => ({
  find: jest.fn((filter) => { calls.push(["find", filter]); return { sort: async () => [] }; }),
  create: jest.fn(async (doc) => { calls.push(["create", doc]); return { _id: "row", ...doc }; }),
  findOneAndUpdate: jest.fn(async (filter, update) => { calls.push(["findOneAndUpdate", filter, update]); return null; }),
  findOneAndDelete: jest.fn(async (filter) => { calls.push(["findOneAndDelete", filter]); return null; }),
}));

const controller = require("../controllers/iroPaAssignment.controller");

const TENANT = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ROW = "d00000000000000000000001";

const run = async (handler, { body = {}, params = {} } = {}) => {
  const req = { ctx: { tenantId: TENANT }, body, params };
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let err = null;
  await controller[handler](req, res, (e) => { err = e; });
  return { res, err };
};

beforeEach(() => { calls.length = 0; });

test("list is bound to the caller's tenant", async () => {
  await run("list");
  expect(calls).toEqual([["find", { tenantId: TENANT }]]);
});

test("create stores the caller's tenant; a tenantId in the body is ignored", async () => {
  const { res } = await run("create", { body: { iroUserId: "iro1", paUserId: "pa1", tenantId: OTHER } });
  expect(res.statusCode).toBe(201);
  expect(calls).toEqual([["create", { tenantId: TENANT, iroUserId: "iro1", paUserId: "pa1" }]]);
});

test("update matches on id AND the caller's tenant, changes only paUserId; another tenant's row -> 404", async () => {
  const { err } = await run("update", { params: { id: ROW }, body: { paUserId: "pa2", tenantId: OTHER, iroUserId: "x" } });
  expect(calls).toEqual([["findOneAndUpdate", { _id: ROW, tenantId: TENANT }, { $set: { paUserId: "pa2" } }]]);
  expect(err && err.status).toBe(404);
});

test("remove matches on id AND the caller's tenant; another tenant's row -> 404", async () => {
  const { err } = await run("remove", { params: { id: ROW } });
  expect(calls).toEqual([["findOneAndDelete", { _id: ROW, tenantId: TENANT }]]);
  expect(err && err.status).toBe(404);
});

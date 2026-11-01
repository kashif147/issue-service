// GET /templates/default is read-only: it resolves the user's default view, else the system default
// (tenant-owned first, then the legacy tenantless row), else null (= the client's built-in default).
// It used to persist a blank user view (columns: []) whenever the user had no default - the shape of
// the two blank issuessummary views found on DEV.
// Part 1: REAL service + controller, Template model methods spied (every write path must stay unused).
// Part 2: REAL service against a throwaway mongod (MONGOD_BIN or `mongod` on PATH; skipped otherwise).
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const Template = require("../models/template.model");
const service = require("../services/issueTemplate.service");
const controller = require("../controllers/issueTemplate.controller");

jest.setTimeout(60000);

const TENANT = "68cbf7806080b4621d469d34";
const OTHER_TENANT = "68ebf0806080b4621d461ae0";
const USER = "700000000000000000000001";

const WRITE_METHODS = ["create", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate", "replaceOne", "bulkWrite", "deleteOne", "deleteMany"];
function spyWrites() {
  const spies = WRITE_METHODS.map((name) => jest.spyOn(Template, name).mockImplementation(() => { throw new Error(`write ${name}`); }));
  spies.push(jest.spyOn(Template.prototype, "save").mockImplementation(() => { throw new Error("write save"); }));
  return spies;
}
const writeCalls = (spies) => spies.reduce((n, s) => n + s.mock.calls.length, 0);
const fakeDoc = (fields) => ({ ...fields, toObject() { return { ...fields }; } });

function mockReads({ own = null, tenantDefault = null, sharedDefault = null } = {}) {
  return jest.spyOn(Template, "findOne").mockImplementation(async (q) => {
    if (q.userId) return own;
    if (q.systemDefault && q.tenantId) return tenantDefault;
    if (q.systemDefault && q.$or) return sharedDefault;
    return null;
  });
}

describe("GET /templates/default - read-only resolution (spied model)", () => {
  afterEach(() => jest.restoreAllMocks());

  test("no user default + no system default: zero writes, null (client built-in default)", async () => {
    const spies = spyWrites();
    mockReads();
    await expect(service.getDefaultTemplate(USER, TENANT)).resolves.toEqual({ source: "builtin", template: null });
    expect(writeCalls(spies)).toBe(0);
  });

  test("no user default: returns the tenant-owned system default (preferred over the shared row), zero writes", async () => {
    const spies = spyWrites();
    const find = mockReads({
      tenantDefault: fakeDoc({ _id: "t1", tenantId: TENANT, systemDefault: true, templateType: "issuesftp", columns: ["caseTitle"], meta: {} }),
      sharedDefault: fakeDoc({ _id: "s1", tenantId: null, systemDefault: true, templateType: "issuesftp", columns: ["x"] }),
    });
    const r = await service.getDefaultTemplate(USER, TENANT, "IssuesFTP");
    expect(r).toMatchObject({ source: "system", template: { _id: "t1", isDefault: true, columns: ["caseTitle"] } });
    expect(r.template.meta).toBeUndefined();
    expect(find.mock.calls[0][0]).toMatchObject({ userId: USER, templateType: "issuesftp", isDefault: true });
    expect(writeCalls(spies)).toBe(0);
  });

  test("falls back to the legacy tenantless system default when the tenant has none", async () => {
    const spies = spyWrites();
    mockReads({ sharedDefault: fakeDoc({ _id: "s1", tenantId: null, systemDefault: true, templateType: "issuesclosed" }) });
    await expect(service.getDefaultTemplate(USER, TENANT, "issuesclosed")).resolves.toMatchObject({ source: "system", template: { _id: "s1" } });
    expect(writeCalls(spies)).toBe(0);
  });

  test("the user's own default view wins", async () => {
    const spies = spyWrites();
    mockReads({ own: fakeDoc({ _id: "u1", userId: USER, isDefault: true, templateType: "issuessummary", columns: ["caseTitle"] }) });
    await expect(service.getDefaultTemplate(USER, TENANT)).resolves.toMatchObject({ source: "user", template: { _id: "u1" } });
    expect(writeCalls(spies)).toBe(0);
  });

  test("controller: 200 with data null + source builtin; type from ?type or ?templateType", async () => {
    const spies = spyWrites();
    const find = mockReads();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const req = { user: { userType: "CRM" }, ctx: { userId: USER, tenantId: TENANT }, query: { templateType: "issuesftp" } };
    await controller.getDefaultTemplate(req, res, (e) => { throw e; });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null, source: "builtin" });
    expect(find.mock.calls[0][0].templateType).toBe("issuesftp");
    expect(writeCalls(spies)).toBe(0);
  });
});

const mongodBin =
  process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;
if (!mongodBin) console.warn("GET /templates/default real-mongod tests skipped: no mongod binary (set MONGOD_BIN)");

describeDb("GET /templates/default - zero writes against a real mongod", () => {
  let mongod;
  let dbPath;
  const freePort = () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  const coll = () => mongoose.connection.db.collection("templates");
  const state = async () => JSON.stringify(await coll().find({}).sort({ _id: 1 }).toArray());

  beforeAll(async () => {
    const port = await freePort();
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "igd-getdefault-"));
    mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 60; i += 1) {
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/issue-getdefault-test`, { serverSelectionTimeoutMS: 500 });
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) mongod.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (dbPath && dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await coll().deleteMany({});
    await coll().insertMany([
      { templateType: "issuescomplaints", tenantId: null, systemDefault: true, isDefault: false, columns: ["caseTitle", "ownerTeam"], meta: { deleted: false } },
      { templateType: "issuescomplaints", tenantId: OTHER_TENANT, systemDefault: true, isDefault: false, columns: ["other"], meta: { deleted: false } },
    ]);
  });

  test("repeated GET with no user default is idempotent: no row created, no columns:[] record", async () => {
    const before = await state();
    const first = await service.getDefaultTemplate(USER, TENANT);
    const second = await service.getDefaultTemplate(USER, TENANT);
    expect(first).toEqual({ source: "builtin", template: null });
    expect(second).toEqual(first);
    expect(await state()).toBe(before);
    expect(await coll().countDocuments({ columns: { $size: 0 } })).toBe(0);
  });

  test("resolves the shared default (never another tenant's) without writing", async () => {
    const before = await state();
    const r = await service.getDefaultTemplate(USER, TENANT, "issuescomplaints");
    expect(r.source).toBe("system");
    expect(r.template.columns).toEqual(["caseTitle", "ownerTeam"]);
    expect(String(r.template.tenantId)).not.toBe(OTHER_TENANT);
    expect(await state()).toBe(before);
  });
});

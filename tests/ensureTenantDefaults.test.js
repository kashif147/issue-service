// ensureTenantDefaults(tenantId, manifestVersion) - the provisioning entry point for issue grid system
// defaults (services/tenantGridDefaults.js), against a REAL throwaway mongod (skipped when no mongod
// binary: set MONGOD_BIN). Insert-only and idempotent; it never touches user views, the transitional
// tenantless rows or an existing (possibly customised) tenant default, and never creates issuessummary.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const g = require("../services/tenantGridDefaults");

jest.setTimeout(60000);

const A = "68cbf7806080b4621d469d34";
const B = "68ebf0806080b4621d461ae0";
const TYPES = ["issuesclosed", "issuescomplaints", "issuesftp", "issuesir", "issuesdataprotection"];
const mongodBin =
  process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;

describeDb("issue ensureTenantDefaults (real mongod)", () => {
  let mongod;
  let dbPath;
  const coll = () => mongoose.connection.db.collection("templates");
  const shared = (type) => ({ name: "System default", templateType: type, tenantId: null, systemDefault: true, columns: ["ownerTeam"], columnLabels: { ownerTeam: "Owner" }, meta: { deleted: false } });

  beforeAll(async () => {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
      srv.on("error", reject);
    });
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "issue-ensure-"));
    mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/issue-ensure-test`, { serverSelectionTimeoutMS: 500 });
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (mongoose.connection.readyState !== 1) throw new Error("throwaway mongod did not start");
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) { const exited = new Promise((r) => mongod.once("exit", r)); mongod.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    try {
      if (dbPath && dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true });
    } catch (_) {
      // best-effort temp cleanup (mongod may still be flushing)
    }
  });
  beforeEach(async () => {
    await coll().deleteMany({});
    await coll().dropIndexes().catch(() => {});
    await coll().insertMany([
      ...TYPES.map(shared),
      { templateType: "issuessummary", tenantId: A, userId: new mongoose.Types.ObjectId(), systemDefault: false, isDefault: true, columns: [], meta: { deleted: false } },
    ]);
  });

  test("the v1 manifest is the committed issue manifest: the five types, never issuessummary", () => {
    const c = g.loadCanonical();
    expect(c.version).toBe(1);
    expect(Object.keys(c.templates).sort()).toEqual([...TYPES].sort());
  });

  test("validates tenant and manifest version", async () => {
    await expect(g.ensureTenantDefaults("MULTIAUTH", 1, { collection: coll() })).rejects.toThrow(/invalid internal tenant id/);
    await expect(g.ensureTenantDefaults(A, 2, { collection: coll() })).rejects.toThrow(/manifest version/);
  });

  test("inserts the missing defaults once, skips an existing (customised) one, idempotent, touches nothing else", async () => {
    const { insertedId } = await coll().insertOne({ ...shared("issuesir"), tenantId: B, name: "B custom", columns: ["mine"] });
    const custom = g.docHash(await coll().findOne({ _id: insertedId }));
    const before = await g.snapshot(coll());
    const first = await g.ensureTenantDefaults(B, 1, { collection: coll() });
    expect(first).toMatchObject({ insertedCount: 4, skippedCount: 1 });
    expect(first.skipped[0]).toMatchObject({ templateType: "issuesir", id: String(insertedId) });
    const second = await g.ensureTenantDefaults(B, 1, { collection: coll() });
    expect(second).toMatchObject({ insertedCount: 0, skippedCount: 5 });
    expect(g.docHash(await coll().findOne({ _id: insertedId }))).toBe(custom);
    const after = await g.snapshot(coll());
    expect(after.userViews).toEqual(before.userViews);
    expect(after.tenantless).toEqual(before.tenantless);
    expect(await coll().countDocuments({ templateType: "issuessummary", systemDefault: true })).toBe(0);
    const row = await coll().findOne({ tenantId: B, templateType: "issuescomplaints", systemDefault: true });
    expect(row.columns).toEqual(g.loadCanonical().templates.issuescomplaints.columns);
    expect(row.userId).toBeUndefined();
  });

  test("with the unique index in place a duplicate active default is rejected, and ensure skips the existing row", async () => {
    await g.ensureIndex(coll());
    await expect(coll().insertMany([{ ...shared("issuesftp"), tenantId: A }, { ...shared("issuesftp"), tenantId: A }])).rejects.toMatchObject({ code: 11000 });
    const r = await g.ensureTenantDefaults(A, 1, { collection: coll() });
    expect(r.insertedCount).toBe(4);
    expect(await coll().countDocuments({ tenantId: A, templateType: "issuesftp", systemDefault: true })).toBe(1);
  });
});

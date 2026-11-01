// Issue grid system defaults -> tenant-owned (scripts/migrate-issue-grid-defaults-to-tenants.js).
// Runs against a REAL throwaway mongod (local binary: MONGOD_BIN or `mongod` on PATH) so the partial
// unique index and the insert/skip/rollback paths are exercised for real. Skipped (with a message)
// when no mongod binary is available.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const m = require("../scripts/migrate-issue-grid-defaults-to-tenants");

const { ObjectId } = mongoose.mongo;
jest.setTimeout(60000);

const mongodBin =
  process.env.MONGOD_BIN ||
  (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;
if (!mongodBin) console.warn("migrateIssueGridDefaults tests skipped: no mongod binary (set MONGOD_BIN)");

const A = "68cbf7806080b4621d469d34";
const B = "68ebf0806080b4621d461ae0";
const C = "68f3f0806080b4621d46fd57";
const USER = new ObjectId("700000000000000000000001");
const TYPES = m.ISSUE_GRID_DEFAULT_TYPES;
const OLD_COLS = ["caseTitle", "memberIds", "issueStatus", "priority", "ownerTeam"];

let mongod;
let dbPath;
let db;
const outDirs = [];

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

async function startMongod() {
  const port = await freePort();
  dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "igd-mongod-"));
  mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  const uri = `mongodb://127.0.0.1:${port}/issue-grid-migration-test`;
  for (let i = 0; i < 60; i += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 });
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("mongod did not start");
}

const coll = () => db.collection(m.COLLECTION);
const tenantless = (type) => ({
  name: "System default", templateType: type, tenantId: null, systemDefault: true, isDefault: false, pinned: false,
  columns: [...OLD_COLS], columnLabels: { ownerTeam: "Owner" }, filters: { priority: { operator: "equal_to", values: [] } },
  visibleFilters: [], meta: { deleted: false, deletedAt: null }, createdAt: new Date("2026-08-05T16:58:22Z"), updatedAt: new Date("2026-08-05T16:58:22Z"),
});
const userView = (fields) => ({
  name: "My view", templateType: "issuescomplaints", tenantId: A, userId: USER, systemDefault: false, isDefault: true, pinned: false,
  columns: [...OLD_COLS], columnLabels: { ownerTeam: "Owner" }, filters: { issueStatus: { operator: "equal_to", values: ["OPEN"] } },
  visibleFilters: ["Owner"], meta: { deleted: false, deletedAt: null }, createdAt: new Date("2026-08-06T05:30:42Z"), updatedAt: new Date("2026-08-06T05:30:42Z"),
  ...fields,
});

async function seedDevShape() {
  await coll().deleteMany({});
  await coll().dropIndexes().catch(() => {});
  await coll().insertMany(TYPES.map(tenantless));
  await coll().insertMany([
    userView({}),
    userView({ name: null, templateType: "issuessummary", columns: [], columnLabels: undefined, filters: undefined, visibleFilters: [] }),
    userView({ templateType: "issuesclosed", meta: { deleted: true, deletedAt: new Date() } }),
  ]);
}

const outDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "igd-out-"));
  outDirs.push(d);
  return d;
};
const plan = async (tenants) => {
  const p = await m.planMigration(db, tenants, m.loadCanonical());
  p.canonicalSource = m.loadCanonical().source;
  return p;
};
const apply = async (tenants, runId) => m.applyMigration(db, await plan(tenants), { outDir: outDir(), runId, dbName: "test" });
const allHashes = async () => (await coll().find({}).sort({ _id: 1 }).toArray()).map((d) => m.docHash(d));
const indexNames = async () => (await coll().indexes()).map((i) => i.name).sort();

describeDb("issue grid tenant-owned defaults migration (real mongod)", () => {
  beforeAll(async () => {
    await startMongod();
    db = mongoose.connection.db;
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) mongod.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const d of [dbPath, ...outDirs]) if (d && d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  });
  beforeEach(seedDevShape);

  test("canonical config: the 5 types, 14 columns, Owner/Team/Created By, no issuessummary", () => {
    const c = m.loadCanonical();
    expect(Object.keys(c.templates).sort()).toEqual([...TYPES].sort());
    for (const t of TYPES) {
      const tpl = c.templates[t];
      expect(tpl.columns).toHaveLength(14);
      expect(tpl.columns.slice(-3)).toEqual(["ownerName", "ownerTeam", "createdBy"]);
      expect(tpl.columnLabels).toMatchObject({ memberIds: "Member Name", ownerName: "Owner", ownerTeam: "Team", createdBy: "Created By" });
    }
    expect(c.source).toMatchObject({ repo: "ProjectShell-1", commit: "7983fed" });
  });

  test("tenant ids are explicit and validated", () => {
    expect(() => m.parseTenantIds("")).toThrow(/required/);
    expect(() => m.parseTenantIds("MULTIAUTH")).toThrow(/invalid tenant id/);
    expect(() => m.parseTenantIds(`${A},${A}`)).toThrow(/duplicate/);
    expect(m.parseTenantIds(` ${A},${B} `)).toEqual([A, B]);
  });

  test("dry run writes nothing and detects all five types per tenant (never issuessummary)", async () => {
    const hashes = await allHashes();
    const idx = await indexNames();
    const p = await plan([A, B, C]);
    const index = await m.inspectIndex(db);
    expect(p.inserts).toBe(15);
    expect(p.skips).toBe(0);
    expect(p.anomalies).toEqual([]);
    for (const t of [A, B, C]) expect(p.items.filter((i) => i.tenantId === t).map((i) => i.templateType)).toEqual([...TYPES]);
    expect(p.items.some((i) => i.templateType === "issuessummary")).toBe(false);
    expect(index).toMatchObject({ state: "absent", covered: 0, duplicateGroups: 0, anomalies: [] });
    expect(await allHashes()).toEqual(hashes);
    expect(await indexNames()).toEqual(idx);
  });

  test("missing tenant defaults insert once, with the canonical shape; second run is a no-op", async () => {
    const r = await apply([A], "run1");
    expect(r.ledger.status).toBe("applied");
    expect(r.ledger.inserted).toHaveLength(5);
    for (const type of TYPES) {
      const rows = await coll().find({ tenantId: A, templateType: type, systemDefault: true, "meta.deleted": false }).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBeUndefined();
      expect(rows[0].columns).toEqual(m.loadCanonical().templates[type].columns);
      expect(rows[0].columnLabels.ownerTeam).toBe("Team");
    }
    const again = await plan([A]);
    expect(again).toMatchObject({ inserts: 0, skips: 5 });
    const r2 = await apply([A], "run2");
    expect(r2.ledger.inserted).toHaveLength(0);
    expect(await coll().countDocuments({ tenantId: A, systemDefault: true })).toBe(5);
  });

  test("an existing tenant-owned default is skipped and never updated", async () => {
    const custom = { ...tenantless("issuescomplaints"), tenantId: B, name: "B custom", columns: ["caseTitle"], columnLabels: { caseTitle: "Ref" } };
    const { insertedId } = await coll().insertOne(custom);
    const before = m.docHash(await coll().findOne({ _id: insertedId }));
    const p = await plan([B]);
    expect(p.items.find((i) => i.templateType === "issuescomplaints")).toMatchObject({ action: "skip", existingId: String(insertedId) });
    const r = await m.applyMigration(db, p, { outDir: outDir(), runId: "skip", dbName: "test" });
    expect(r.ledger.inserted).toHaveLength(4);
    expect(m.docHash(await coll().findOne({ _id: insertedId }))).toBe(before);
  });

  test("user views and tenantless rows are never matched or mutated (hash, updatedAt, filters, order)", async () => {
    const before = await m.snapshot(db);
    const r = await apply([A, B, C], "protect");
    expect(r.ledger.verification.protectedDiffs).toEqual([]);
    const after = await m.snapshot(db);
    expect(after.userViews).toEqual(before.userViews);
    expect(after.tenantless).toEqual(before.tenantless);
    expect(m.protectedDiff(before, after)).toEqual([]);
    expect(after.tenantOwned).toHaveLength(15);
  });

  test("a protected-row change is detected by the snapshot diff", async () => {
    const before = await m.snapshot(db);
    await coll().updateOne({ systemDefault: false, templateType: "issuescomplaints" }, { $set: { columns: ["x"], updatedAt: new Date() } });
    expect(m.protectedDiff(before, await m.snapshot(db)).join()).toMatch(/userViews: .* changed/);
  });

  test("another tenant's default is never reused", async () => {
    await coll().insertOne({ ...tenantless("issuescomplaints"), tenantId: C });
    const p = await plan([A]);
    expect(p.items.find((i) => i.templateType === "issuescomplaints")).toMatchObject({ action: "insert" });
  });

  test("the partial unique index blocks a second active tenant default only", async () => {
    await apply([A], "idx");
    const idx = (await coll().indexes()).find((i) => i.name === m.INDEX_NAME);
    expect(idx).toMatchObject({ unique: true, key: m.INDEX_KEY, partialFilterExpression: m.INDEX_PARTIAL });
    const dup = { ...tenantless("issuescomplaints"), tenantId: A };
    await expect(coll().insertOne(dup)).rejects.toMatchObject({ code: 11000 });
    await expect(coll().insertOne({ ...dup, meta: { deleted: true, deletedAt: new Date() } })).resolves.toBeTruthy(); // soft-deleted
    await expect(coll().insertOne(userView({ templateType: "issuescomplaints" }))).resolves.toBeTruthy(); // user view
    await expect(coll().insertOne(tenantless("issuescomplaints"))).resolves.toBeTruthy(); // tenantless (transition)
    const index = await m.inspectIndex(db);
    expect(index).toMatchObject({ state: "present", anomalies: [] });
  });

  test("the partial index covers only string tenant ids: null, missing, \"\" and ObjectId rows are outside it", async () => {
    await apply([A], "edge");
    const oid = new ObjectId(B);
    const base = { ...tenantless("issuesftp") };
    delete base.tenantId;
    const outside = [
      { ...base, tenantId: null }, { ...base, tenantId: null }, // null x2
      { ...base }, { ...base }, // missing x2
      { ...base, tenantId: "" }, { ...base, tenantId: "" }, // empty string x2
      { ...base, tenantId: oid }, { ...base, tenantId: oid }, // same ObjectId x2
    ];
    await expect(coll().insertMany(outside)).resolves.toBeTruthy(); // no unique violation: none is indexed
    const indexed = await coll().find(m.INDEX_PARTIAL).toArray();
    expect(indexed).toHaveLength(5);
    expect(indexed.every((d) => d.tenantId === A)).toBe(true);
    // index usage agrees: an index-only count on the partial filter sees exactly the 5 string-tenant rows
    expect(await coll().countDocuments(m.INDEX_PARTIAL, { hint: m.INDEX_NAME })).toBe(5);
  });

  test("an ObjectId-typed tenantId for a requested tenant is refused (anomaly, apply blocked)", async () => {
    await coll().insertOne({ ...tenantless("issuesir"), tenantId: new ObjectId(B) });
    const p = await plan([B]);
    expect(p.anomalies.join()).toMatch(/store tenantId as ObjectId/);
    const hashes = await allHashes();
    await expect(m.applyMigration(db, p, { outDir: outDir(), runId: "oid", dbName: "test" })).rejects.toThrow(/refusing to apply/);
    expect(await allHashes()).toEqual(hashes);
  });

  test("pre-existing duplicate active tenant defaults are reported and block apply", async () => {
    await coll().insertMany([{ ...tenantless("issuesir"), tenantId: B }, { ...tenantless("issuesir"), tenantId: B }]);
    const index = await m.inspectIndex(db);
    expect(index.duplicateGroups).toBe(1);
    const p = await plan([B]);
    expect(p.anomalies.join()).toMatch(/2 active tenant defaults/);
    const hashes = await allHashes();
    await expect(m.applyMigration(db, p, { outDir: outDir(), runId: "dupe", dbName: "test" })).rejects.toThrow(/refusing to apply/);
    expect(await allHashes()).toEqual(hashes);
  });

  test("apply writes a full backup and a ledger, and never overwrites an existing one", async () => {
    const dir = outDir();
    const p = await plan([A]);
    const r = await m.applyMigration(db, p, { outDir: dir, runId: "same", dbName: "test" });
    const backup = mongoose.mongo.BSON.EJSON.parse(fs.readFileSync(r.backupFile, "utf8"));
    expect(backup).toHaveLength(8); // the 8 rows present before the inserts
    expect(JSON.parse(fs.readFileSync(r.ledgerFile, "utf8")).planned).toHaveLength(5);
    await expect(m.applyMigration(db, await plan([B]), { outDir: dir, runId: "same", dbName: "test" })).rejects.toThrow(/EEXIST/);
  });

  test("rollback deletes only unmodified ledger inserts; dry rollback deletes nothing", async () => {
    await coll().insertOne({ ...tenantless("issuescomplaints"), tenantId: B, name: "B custom" });
    const r = await apply([A, B], "rb");
    const custom = r.ledger.inserted.find((x) => x.tenantId === A && x.templateType === "issuesir");
    await coll().updateOne({ _id: new ObjectId(custom.id) }, { $set: { columns: ["caseTitle"], updatedAt: new Date() } });
    const protectedBefore = await m.snapshot(db);

    const dry = await m.rollbackMigration(db, r.ledgerFile);
    expect(dry.results.filter((x) => x.action === "would-delete")).toHaveLength(8);
    expect(await coll().countDocuments({ systemDefault: true, tenantId: { $gt: "" } })).toBe(10);

    const done = await m.rollbackMigration(db, r.ledgerFile, { apply: true });
    expect(done.results.filter((x) => x.action === "deleted")).toHaveLength(8);
    expect(done.results.find((x) => x.id === custom.id).action).toBe("kept-modified-since-insert");
    const left = await coll().find({ systemDefault: true, tenantId: { $gt: "" } }).toArray();
    expect(left.map((d) => d.name).sort()).toEqual(["B custom", "System default"]); // pre-existing B row + the customised insert
    const after = await m.snapshot(db);
    expect(m.protectedDiff(protectedBefore, after)).toEqual([]);
  });
});

/**
 * Issue grid "Save View" system defaults -> tenant-owned (ownership migration, insert-only).
 *
 * The five issue grid system defaults (issuesclosed, issuescomplaints, issuesftp, issuesir,
 * issuesdataprotection) exist today only as shared tenantless rows (tenantId null) that every tenant
 * resolves through the legacy fallback in services/issueTemplate.service.js (tenant-owned first, then
 * tenantless). This script gives each EXPLICITLY LISTED tenant its own active system default per type,
 * built from the vendored canonical manifest config/issueGridSystemDefaults.v1.json.
 *
 * Rules (owner-approved scope, 2026-11-01):
 *  - DRY RUN by default; writes only with --apply (and --db=<connected database name>).
 *  - Tenants come only from --tenants=<internal tenant id,...>; never inferred from data.
 *  - Insert-only: an existing active tenant-owned default for a tenant/type is SKIPPED, never updated.
 *  - Never touches user views or the tenantless legacy rows (proved by before/after snapshots).
 *  - issuessummary is NOT persisted (it stays code-defined in the CRM).
 *  - --apply first writes a full templates backup and a ledger (planned _ids before inserting);
 *    --rollback=<ledger> deletes only ledger inserts that are still unmodified.
 *  - Creates the partial unique index uniq_active_tenant_system_default_per_type (one active
 *    tenant-owned system default per tenantId + templateType); user views, soft-deleted rows and
 *    tenantless rows are outside its partial filter.
 *
 * Usage (inside the issue-service container / with MONGO_URI set):
 *   node scripts/migrate-issue-grid-defaults-to-tenants.js --tenants=<id>[,<id>...]
 *   node scripts/migrate-issue-grid-defaults-to-tenants.js --tenants=<id> --apply --db=<dbName> --out=<dir>
 *   node scripts/migrate-issue-grid-defaults-to-tenants.js --rollback=<ledger.json> [--apply --db=<dbName>]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

const { EJSON } = mongoose.mongo.BSON;
const { ObjectId } = mongoose.mongo;

const COLLECTION = "templates";
const ISSUE_GRID_DEFAULT_TYPES = Object.freeze([
  "issuesclosed",
  "issuescomplaints",
  "issuesftp",
  "issuesir",
  "issuesdataprotection",
]);
const INDEX_NAME = "uniq_active_tenant_system_default_per_type";
const INDEX_KEY = Object.freeze({ tenantId: 1, templateType: 1 });
const INDEX_PARTIAL = Object.freeze({ systemDefault: true, "meta.deleted": false, tenantId: { $gt: "" } });
const CANONICAL_PATH = path.join(__dirname, "..", "config", "issueGridSystemDefaults.v1.json");
const CANONICAL_TITLES = Object.freeze({ ownerName: "Owner", ownerTeam: "Team", createdBy: "Created By" });

const TENANT_ID_RE = /^[0-9a-f]{24}$/;
const mask = (id) => `…${String(id).slice(-6)}`;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const docHash = (doc) => sha256(EJSON.stringify(doc, { relaxed: false }));
const isTenantless = (doc) => doc.tenantId == null || doc.tenantId === "";

function parseTenantIds(raw) {
  const ids = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error("--tenants=<internal tenant id,...> is required (tenants are never inferred)");
  for (const id of ids) {
    if (!TENANT_ID_RE.test(id)) throw new Error(`invalid tenant id ${mask(id)} (expected 24 lowercase hex)`);
  }
  if (new Set(ids).size !== ids.length) throw new Error("duplicate tenant id in --tenants");
  return ids;
}

/** The vendored canonical configs, validated (5 types, labels for every column, canonical titles). */
function loadCanonical(file = CANONICAL_PATH) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.version !== 1) throw new Error(`unsupported canonical version ${data.version}`);
  for (const type of ISSUE_GRID_DEFAULT_TYPES) {
    const t = data.templates && data.templates[type];
    if (!t || t.templateType !== type) throw new Error(`canonical config missing ${type}`);
    if (!Array.isArray(t.columns) || !t.columns.length) throw new Error(`${type}: no columns`);
    if (new Set(t.columns).size !== t.columns.length) throw new Error(`${type}: duplicate columns`);
    for (const key of t.columns) {
      if (!t.columnLabels || !t.columnLabels[key]) throw new Error(`${type}: no label for ${key}`);
    }
    for (const [key, title] of Object.entries(CANONICAL_TITLES)) {
      if (!t.columns.includes(key) || t.columnLabels[key] !== title) throw new Error(`${type}: ${key} must be "${title}"`);
    }
  }
  if (data.templates.issuessummary) throw new Error("issuessummary must not be persisted by this migration");
  return data;
}

function buildTenantDefault(canonical, tenantId, type, now, _id) {
  const t = canonical.templates[type];
  return {
    _id,
    name: t.name,
    templateType: type,
    tenantId,
    filters: JSON.parse(JSON.stringify(t.filters || {})),
    columns: [...t.columns],
    columnLabels: { ...t.columnLabels },
    visibleFilters: [...(t.visibleFilters || [])],
    isDefault: false,
    pinned: false,
    systemDefault: true,
    meta: { deleted: false, deletedAt: null },
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };
}

/** Every templates row, classified, with content hashes (used before and after every apply). */
async function snapshot(db) {
  const docs = await db.collection(COLLECTION).find({}).sort({ _id: 1 }).toArray();
  const row = (d) => ({
    id: String(d._id),
    templateType: d.templateType,
    hash: docHash(d),
    updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
    columnsHash: sha256(JSON.stringify(d.columns || [])),
    filtersHash: sha256(EJSON.stringify(d.filters ?? null)),
  });
  const userViews = docs.filter((d) => d.systemDefault !== true).map(row);
  const tenantless = docs.filter((d) => d.systemDefault === true && isTenantless(d)).map(row);
  const tenantOwned = docs
    .filter((d) => d.systemDefault === true && !isTenantless(d))
    .map((d) => ({ ...row(d), tenantId: String(d.tenantId), deleted: !!(d.meta && d.meta.deleted) }));
  return { total: docs.length, userViews, tenantless, tenantOwned };
}

/** Differences in the protected sets (user views, tenantless rows) between two snapshots. */
function protectedDiff(before, after) {
  const diffs = [];
  for (const set of ["userViews", "tenantless"]) {
    const a = new Map(before[set].map((r) => [r.id, r]));
    const b = new Map(after[set].map((r) => [r.id, r]));
    if (a.size !== b.size) diffs.push(`${set}: count ${a.size} -> ${b.size}`);
    for (const [id, r] of a) {
      const s = b.get(id);
      if (!s) diffs.push(`${set}: ${mask(id)} missing`);
      else if (s.hash !== r.hash || s.updatedAt !== r.updatedAt) diffs.push(`${set}: ${mask(id)} changed`);
    }
    for (const id of b.keys()) if (!a.has(id)) diffs.push(`${set}: ${mask(id)} added`);
  }
  return diffs;
}

/** State of the partial unique index and whether current data would satisfy it. */
async function inspectIndex(db) {
  const coll = db.collection(COLLECTION);
  const indexes = await coll.indexes();
  const anomalies = [];
  const same = (a, b) => EJSON.stringify(a) === EJSON.stringify(b);
  const named = indexes.find((i) => i.name === INDEX_NAME);
  const sameKey = indexes.filter((i) => i.name !== INDEX_NAME && same(i.key, INDEX_KEY));
  if (sameKey.length) anomalies.push(`index key ${JSON.stringify(INDEX_KEY)} already used by ${sameKey.map((i) => i.name).join(",")}`);
  let state = "absent";
  if (named) {
    if (!same(named.key, INDEX_KEY) || named.unique !== true || !same(named.partialFilterExpression, INDEX_PARTIAL)) {
      anomalies.push(`index ${INDEX_NAME} exists with a different definition`);
    }
    state = "present";
  }
  const covered = await coll.countDocuments(INDEX_PARTIAL);
  const dupGroups = await coll
    .aggregate([
      { $match: INDEX_PARTIAL },
      { $group: { _id: { tenantId: "$tenantId", templateType: "$templateType" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  for (const g of dupGroups) anomalies.push(`duplicate active tenant default ${mask(g._id.tenantId)}/${g._id.templateType} x${g.n}`);
  return { state, covered, duplicateGroups: dupGroups.length, existing: indexes.map((i) => i.name), anomalies };
}

/** Insert/skip decision for every tenant x type. Never writes. */
async function planMigration(db, tenantIds, canonical) {
  const coll = db.collection(COLLECTION);
  const now = new Date();
  const items = [];
  const anomalies = [];
  for (const tenantId of tenantIds) {
    // a tenantId stored as an ObjectId would not match the runtime's string query - surface it
    const oidTyped = await coll.countDocuments({ tenantId: new ObjectId(tenantId) });
    if (oidTyped) anomalies.push(`${mask(tenantId)}: ${oidTyped} row(s) store tenantId as ObjectId`);
    for (const type of ISSUE_GRID_DEFAULT_TYPES) {
      const existing = await coll
        .find({ tenantId, templateType: type, systemDefault: true, "meta.deleted": false })
        .toArray();
      if (existing.length > 1) {
        anomalies.push(`${mask(tenantId)}/${type}: ${existing.length} active tenant defaults`);
        items.push({ tenantId, templateType: type, action: "anomaly", existingIds: existing.map((d) => String(d._id)) });
      } else if (existing.length === 1) {
        if (existing[0].userId) anomalies.push(`${mask(tenantId)}/${type}: active system default carries a userId`);
        items.push({ tenantId, templateType: type, action: "skip", existingId: String(existing[0]._id) });
      } else {
        const doc = buildTenantDefault(canonical, tenantId, type, now, new ObjectId());
        items.push({ tenantId, templateType: type, action: "insert", id: String(doc._id), doc });
      }
    }
  }
  return {
    tenants: tenantIds,
    types: [...ISSUE_GRID_DEFAULT_TYPES],
    items,
    inserts: items.filter((i) => i.action === "insert").length,
    skips: items.filter((i) => i.action === "skip").length,
    anomalies,
  };
}

function writeNew(file, data) {
  fs.writeFileSync(file, data, { flag: "wx" }); // never overwrite an existing backup/ledger
}

/** Backup -> index -> ledger (planned ids) -> inserts -> verification. */
async function applyMigration(db, plan, { outDir, runId, dbName }) {
  if (plan.anomalies.length) throw new Error(`refusing to apply: ${plan.anomalies.join("; ")}`);
  const index = await inspectIndex(db);
  if (index.anomalies.length) throw new Error(`refusing to apply: ${index.anomalies.join("; ")}`);
  const coll = db.collection(COLLECTION);
  const before = await snapshot(db);

  const allDocs = await coll.find({}).sort({ _id: 1 }).toArray();
  const backupText = EJSON.stringify(allDocs, { relaxed: false });
  const backupFile = path.join(outDir, `issue-templates-ownership-backup-${runId}.json`);
  writeNew(backupFile, backupText);

  let indexCreated = false;
  if (index.state === "absent") {
    await coll.createIndex(INDEX_KEY, { name: INDEX_NAME, unique: true, partialFilterExpression: INDEX_PARTIAL });
    indexCreated = true;
  }

  const ledgerFile = path.join(outDir, `issue-grid-tenant-defaults-ledger-${runId}.json`);
  const ledger = {
    runId,
    dbName,
    createdAt: new Date().toISOString(),
    status: "pending",
    canonical: plan.canonicalSource,
    tenants: plan.tenants,
    backup: { file: path.basename(backupFile), sha256: sha256(backupText), docs: allDocs.length },
    index: { name: INDEX_NAME, created: indexCreated },
    planned: plan.items.filter((i) => i.action === "insert").map((i) => ({ id: i.id, tenantId: i.tenantId, templateType: i.templateType })),
    skipped: plan.items.filter((i) => i.action === "skip").map((i) => ({ existingId: i.existingId, tenantId: i.tenantId, templateType: i.templateType })),
    inserted: [],
    raced: [],
  };
  writeNew(ledgerFile, JSON.stringify(ledger, null, 2));
  const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));

  for (const item of plan.items.filter((i) => i.action === "insert")) {
    try {
      await coll.insertOne(item.doc);
      const stored = await coll.findOne({ _id: item.doc._id });
      ledger.inserted.push({ id: item.id, tenantId: item.tenantId, templateType: item.templateType, hash: docHash(stored) });
    } catch (err) {
      if (err && err.code === 11000) ledger.raced.push({ id: item.id, tenantId: item.tenantId, templateType: item.templateType });
      else {
        ledger.status = "failed";
        ledger.error = err.message;
        saveLedger();
        throw err;
      }
    }
    saveLedger();
  }

  const after = await snapshot(db);
  const diffs = protectedDiff(before, after);
  const coverage = [];
  for (const tenantId of plan.tenants) {
    for (const type of ISSUE_GRID_DEFAULT_TYPES) {
      const n = await coll.countDocuments({ tenantId, templateType: type, systemDefault: true, "meta.deleted": false });
      if (n !== 1) coverage.push(`${mask(tenantId)}/${type}: ${n} active tenant defaults`);
    }
  }
  ledger.status = diffs.length || coverage.length ? "applied-with-verification-errors" : "applied";
  ledger.verification = { protectedDiffs: diffs, coverage };
  saveLedger();
  return { ledgerFile, backupFile, ledger, before, after };
}

/** Deletes only ledger inserts that are still exactly as inserted (a customised row is kept). */
async function rollbackMigration(db, ledgerFile, { apply = false } = {}) {
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  const coll = db.collection(COLLECTION);
  const results = [];
  for (const rec of ledger.inserted || []) {
    const _id = new ObjectId(rec.id);
    const doc = await coll.findOne({ _id });
    if (!doc) results.push({ ...rec, action: "already-absent" });
    else if (String(doc.tenantId) !== rec.tenantId || doc.templateType !== rec.templateType || doc.systemDefault !== true) {
      results.push({ ...rec, action: "refused-identity-mismatch" });
    } else if (docHash(doc) !== rec.hash) {
      results.push({ ...rec, action: "kept-modified-since-insert" });
    } else if (apply) {
      const r = await coll.deleteOne({ _id, tenantId: rec.tenantId, templateType: rec.templateType, systemDefault: true });
      results.push({ ...rec, action: r.deletedCount === 1 ? "deleted" : "delete-missed" });
    } else {
      results.push({ ...rec, action: "would-delete" });
    }
  }
  return { runId: ledger.runId, results };
}

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : "";
  };
  return {
    tenants: get("tenants"),
    apply: argv.includes("--apply"),
    db: get("db"),
    out: get("out") || process.cwd(),
    rollback: get("rollback"),
  };
}

function printSnapshot(label, snap) {
  console.log(`${label}: total=${snap.total} userViews=${snap.userViews.length} tenantless=${snap.tenantless.length} tenantOwned=${snap.tenantOwned.length}`);
  for (const r of snap.userViews) console.log(`  user ${mask(r.id)} ${r.templateType} hash=${r.hash.slice(0, 12)} updatedAt=${r.updatedAt} cols=${r.columnsHash.slice(0, 8)} filters=${r.filtersHash.slice(0, 8)}`);
  for (const r of snap.tenantless) console.log(`  tenantless ${mask(r.id)} ${r.templateType} hash=${r.hash.slice(0, 12)} updatedAt=${r.updatedAt}`);
  for (const r of snap.tenantOwned) console.log(`  tenant ${mask(r.tenantId)} ${mask(r.id)} ${r.templateType} deleted=${r.deleted}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  console.log(`database: ${dbName} | mode: ${args.rollback ? "rollback" : "migrate"} ${args.apply ? "APPLY" : "DRY RUN"}`);
  try {
    if (args.apply && args.db !== dbName) throw new Error(`--apply requires --db=${dbName} (connected database)`);

    if (args.rollback) {
      const r = await rollbackMigration(db, args.rollback, { apply: args.apply });
      for (const x of r.results) console.log(`  ${x.action} ${mask(x.tenantId)}/${x.templateType} ${mask(x.id)}`);
      return r;
    }

    const tenantIds = parseTenantIds(args.tenants);
    const canonical = loadCanonical();
    const before = await snapshot(db);
    printSnapshot("before", before);
    const index = await inspectIndex(db);
    console.log(`index ${INDEX_NAME}: ${index.state}; rows under partial filter=${index.covered}; duplicate groups=${index.duplicateGroups}; existing=[${index.existing.join(", ")}]`);
    const plan = await planMigration(db, tenantIds, canonical);
    plan.canonicalSource = canonical.source;
    console.log(`canonical: v${canonical.version} ${canonical.source.repo}@${canonical.source.commit} ${canonical.source.path} pagesSha256=${canonical.source.pagesSha256.slice(0, 12)}`);
    for (const i of plan.items) {
      const what = i.action === "insert" ? `${i.doc.columns.length} cols` : i.action === "skip" ? `existing ${mask(i.existingId)}` : i.existingIds.map(mask).join(",");
      console.log(`  ${i.action.toUpperCase()} ${mask(i.tenantId)} ${i.templateType} ${what}`);
    }
    console.log(`plan: inserts=${plan.inserts} skips=${plan.skips} anomalies=${plan.anomalies.length + index.anomalies.length}`);
    for (const a of [...plan.anomalies, ...index.anomalies]) console.log(`  ANOMALY ${a}`);
    if (!args.apply) {
      console.log("DRY RUN: nothing written");
      return { plan, index, before };
    }
    const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const res = await applyMigration(db, plan, { outDir: args.out, runId, dbName });
    printSnapshot("after", res.after);
    console.log(`inserted=${res.ledger.inserted.length} raced=${res.ledger.raced.length} status=${res.ledger.status}`);
    for (const d of res.ledger.verification.protectedDiffs) console.log(`  PROTECTED DIFF ${d}`);
    for (const c of res.ledger.verification.coverage) console.log(`  COVERAGE ${c}`);
    console.log(`ledger: ${res.ledgerFile}\nbackup: ${res.backupFile} sha256=${res.ledger.backup.sha256.slice(0, 12)}`);
    return res;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  COLLECTION,
  ISSUE_GRID_DEFAULT_TYPES,
  INDEX_NAME,
  INDEX_KEY,
  INDEX_PARTIAL,
  parseTenantIds,
  loadCanonical,
  buildTenantDefault,
  snapshot,
  protectedDiff,
  inspectIndex,
  planMigration,
  applyMigration,
  rollbackMigration,
  docHash,
};

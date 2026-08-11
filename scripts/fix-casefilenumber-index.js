/**
 * One-off fix for the tenantId_1_caseFileNumber_1 unique index on the `issues` collection.
 *
 * The index was declared `{ unique: true, sparse: true }` (models/issue.ir.model.js), but a
 * compound sparse index only excludes a document when *every* indexed field is missing -
 * tenantId is always present, so every non-IR issue (COMPLAINT/FTP/DP never set
 * caseFileNumber) was still indexed as {tenantId, caseFileNumber: null}. The second such
 * issue for a tenant then collided on that pair with an E11000 duplicate key error. The
 * schema now declares a partial index instead (see issue.ir.model.js), but Mongoose's
 * autoIndex won't alter an already-built index with different options - it just fails to
 * (re)create it and leaves the old broken one in place. This script drops the old index and
 * builds the corrected one directly.
 *
 * Usage:
 *   node scripts/fix-casefilenumber-index.js --env=staging
 *   node scripts/fix-casefilenumber-index.js --env=staging --dry-run
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const INDEX_NAME = "tenantId_1_caseFileNumber_1";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const hit = args.find((a) => a.startsWith(`${prefix}=`));
    return hit ? hit.slice(prefix.length + 1).trim() : "";
  };
  return {
    envName: get("--env") || "staging",
    dryRun: args.includes("--dry-run"),
  };
}

function loadEnv(envName) {
  const envFile = path.join(__dirname, "..", `.env.${envName}`);
  if (!fs.existsSync(envFile)) {
    console.error(`Env file not found: ${envFile}`);
    process.exit(1);
  }
  require("dotenv").config({ path: envFile, override: true });
  console.log(`Loaded env: ${envFile}`);
}

async function main() {
  const { envName, dryRun } = parseArgs();
  loadEnv(envName);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || "";
  if (!mongoUri) {
    console.error("Set MONGO_URI (or MONGODB_URI) in the env file");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const collection = mongoose.connection.collection("issues");
  const existing = await collection.indexes();
  const badIndex = existing.find((idx) => idx.name === INDEX_NAME);

  if (!badIndex) {
    console.log(`No existing "${INDEX_NAME}" index found - nothing to drop.`);
  } else {
    console.log(`Found existing index "${INDEX_NAME}":`, JSON.stringify(badIndex));
    if (badIndex.partialFilterExpression) {
      console.log("Index is already partial - assuming it's already fixed. Exiting.");
      await mongoose.disconnect();
      return;
    }
    if (dryRun) {
      console.log("[dry-run] Would drop this index.");
    } else {
      await collection.dropIndex(INDEX_NAME);
      console.log(`Dropped index "${INDEX_NAME}".`);
    }
  }

  if (dryRun) {
    console.log("[dry-run] Would create partial unique index on {tenantId, caseFileNumber}.");
  } else {
    await collection.createIndex(
      { tenantId: 1, caseFileNumber: 1 },
      { unique: true, partialFilterExpression: { caseFileNumber: { $type: "string" } } },
    );
    console.log("Created corrected partial unique index.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");

// Local copy of profile-service's config/azure.storage.js - same shared platform Azure
// Storage credentials (AZURE_STORAGE_CONNECTION_STRING or ACCOUNT+KEY), but this service's
// own container default ("issue-attachments") so issue attachments don't land in
// profile-service's "membership-documents" container.
const connectionString = (process.env.AZURE_STORAGE_CONNECTION_STRING || "")
  .replace(/\s+/g, " ")
  .trim();
const accountName = (process.env.AZURE_STORAGE_ACCOUNT || "").trim();
const accountKey = (process.env.AZURE_STORAGE_KEY || "")
  .replace(/\r?\n/g, "")
  .trim();
const containerName = (
  process.env.AZURE_STORAGE_CONTAINER ||
  process.env.AZURE_STORAGE_CONTAINER_NAME ||
  "issue-attachments"
).trim();

let blobServiceClient = null;
let sharedKeyCredential = null;
let resolvedAccountName = accountName;

if (connectionString) {
  blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const nameMatch = connectionString.match(/AccountName=([^;]+)/);
  resolvedAccountName = nameMatch ? nameMatch[1].trim() : accountName;
  const keyMatch = connectionString.match(/AccountKey=([^;]+)/);
  if (keyMatch && keyMatch[1]) {
    sharedKeyCredential = new StorageSharedKeyCredential(
      resolvedAccountName,
      keyMatch[1].trim()
    );
  }
} else if (accountName && accountKey) {
  sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    sharedKeyCredential
  );
}

const isConfigured = Boolean(blobServiceClient && containerName);

module.exports = {
  blobServiceClient,
  sharedKeyCredential,
  containerName,
  accountName: resolvedAccountName,
  isConfigured,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
};

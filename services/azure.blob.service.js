const { randomUUID } = require("crypto");
const {
  blobServiceClient,
  containerName,
  isConfigured,
  sharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("../config/azure.storage");

// Local copy of profile-service's services/azure.blob.service.js. The container is
// private - uploadToBlob's returned .url is not independently fetchable, callers must
// store `blobPath` and call getDownloadSasUrl() fresh on every read (see
// controllers/issueActivity.controller.js#downloadAttachment /
// controllers/issuePortal.controller.js#portalDownloadAttachment).

async function uploadToBlob(
  blobPath,
  buffer,
  contentType,
  downloadFileName = null
) {
  if (!isConfigured) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const nameForDisposition =
    downloadFileName || blobPath.split("/").pop() || "file";
  const asciiFallback = nameForDisposition
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 200) || "file";

  const container = blobServiceClient.getContainerClient(containerName);
  await container.createIfNotExists();
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType || "application/octet-stream",
      blobContentDisposition: `inline; filename="${asciiFallback}"`,
    },
  });
  return blockBlob.url;
}

function getDownloadSasUrl(blobPath, minutes = 15) {
  if (!isConfigured || !sharedKeyCredential || !blobPath) return null;
  const container = blobServiceClient.getContainerClient(containerName);
  const blobClient = container.getBlockBlobClient(blobPath);
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn,
    },
    sharedKeyCredential
  ).toString();
  return `${blobClient.url}?${sas}`;
}

/** issue-attachments/{tenantId}/{issueId}/{uuid}-{suffix} */
function buildIssueAttachmentBlobPath(tenantId, issueId, suffix) {
  return `issue-attachments/${tenantId}/${issueId}/${randomUUID()}-${suffix}`;
}

async function deleteBlob(blobPath) {
  if (!isConfigured || !blobPath) return false;
  const container = blobServiceClient.getContainerClient(containerName);
  const blobClient = container.getBlockBlobClient(blobPath);
  await blobClient.deleteIfExists();
  return true;
}

module.exports = {
  uploadToBlob,
  getDownloadSasUrl,
  buildIssueAttachmentBlobPath,
  deleteBlob,
  isConfigured,
};

const axios = require("axios");

const COMMUNICATION_SERVICE_URL =
  process.env.COMMUNICATION_SERVICE_URL || "http://communication-service:4004";

function buildHeaders(req, tenantId) {
  const headers = {
    "Content-Type": "application/json",
    "x-tenant-id": tenantId || "",
    "x-internal-request": "true",
  };
  if (req?.headers?.authorization) {
    headers.authorization = req.headers.authorization;
  }
  for (const key of [
    "x-jwt-verified",
    "x-auth-source",
    "x-user-id",
    "x-user-email",
    "x-user-type",
    "x-user-roles",
    "x-user-permissions",
  ]) {
    if (req?.headers?.[key]) {
      headers[key] = req.headers[key];
    }
  }
  return headers;
}

/**
 * Trigger a templated email via communication-service's existing template-send pipeline.
 * Not called from anywhere in this slice - the 4 email triggers (IR referred/outcome, due-
 * date approaching, member acknowledgement) are all RabbitMQ-driven from communication-
 * service's own consumer per the plan (§1.3/§1.4/§3.5), not a direct HTTP call from
 * issue-service. Kept here, correctly shaped, for any synchronous trigger a later slice
 * turns out to need.
 */
async function sendTemplatedEmail({ req, tenantId, templateCategory, recipientUserId, placeholders }) {
  const base = COMMUNICATION_SERVICE_URL.replace(/\/$/, "");
  const response = await axios.post(
    `${base}/api/comms/send-templated`,
    { category: templateCategory, recipientUserId, placeholders },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

module.exports = {
  buildHeaders,
  sendTemplatedEmail,
};

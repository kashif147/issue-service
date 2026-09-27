"use strict";
// Focused test: issue-service internal HTTP clients forward x-correlation-id
// from the originating request. Uses an axios stub (no network).
// Run: node --test test/clientHeaders.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Stub axios BEFORE requiring the client (same module instance via require cache).
const axios = require("axios");
let lastConfig = null;
const fake = async (url, config) => {
  lastConfig = config || {};
  return { data: { data: [] } };
};
axios.get = fake;
axios.post = async (url, body, config) => {
  lastConfig = config || {};
  return { data: { data: [] } };
};

const profileClient = require("../services/profileService.client.js");

test("profileService.client forwards x-correlation-id from req", async () => {
  const req = {
    headers: {
      "x-jwt-verified": "true",
      "x-correlation-id": "cid-abc-123",
      authorization: "Bearer should-forward-but-not-asserted-here",
    },
  };
  await profileClient.searchProfiles("q", { req, tenantId: "T1" });
  assert.ok(lastConfig && lastConfig.headers, "request sent with headers");
  assert.equal(lastConfig.headers["x-correlation-id"], "cid-abc-123");
  assert.equal(lastConfig.headers["x-tenant-id"], "T1");
});

test("no x-correlation-id header when req has none", async () => {
  const req = { headers: { "x-jwt-verified": "true" } };
  await profileClient.searchProfiles("q", { req, tenantId: "T1" });
  assert.equal(lastConfig.headers["x-correlation-id"], undefined);
});

// Static guard: all five internal clients include x-correlation-id in their forward list.
test("all issue-service clients forward x-correlation-id", () => {
  const dir = path.join(__dirname, "..", "services");
  const clients = [
    "communicationService.client.js",
    "groupService.client.js",
    "lookup.service.client.js",
    "profileService.client.js",
    "userService.client.js",
  ];
  for (const c of clients) {
    const src = fs.readFileSync(path.join(dir, c), "utf8");
    assert.ok(
      src.includes('"x-correlation-id"'),
      `${c} must forward x-correlation-id`
    );
  }
});

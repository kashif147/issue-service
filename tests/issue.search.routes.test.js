const request = require("supertest");
const app = require("../app");

// Follows tests/app.test.js / tests/issueTemplate.routes.test.js's existing convention:
// AUTH_BYPASS_ENABLED=true (set in tests/setup.js) still requires a Bearer token, so hitting
// the route without one exercises "the route is mounted and sits behind the auth
// middleware" without needing a real gateway/policy-service round trip.
describe("issue-service GET /api/issues/search route", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/issues/search").query({ q: "01-26" });
    expect(res.status).toBe(400);
  });

});

describe("issue.routes registration order", () => {
  it("registers GET /search before GET /:id, so Express can't swallow /search as an :id value", () => {
    const issueRouter = require("../routes/issue.routes");
    const getLayers = issueRouter.stack.filter(
      (layer) => layer.route && layer.route.methods.get,
    );
    const paths = getLayers.map((layer) => layer.route.path);
    expect(paths.indexOf("/search")).toBeGreaterThan(-1);
    expect(paths.indexOf("/:id")).toBeGreaterThan(-1);
    expect(paths.indexOf("/search")).toBeLessThan(paths.indexOf("/:id"));
  });
});

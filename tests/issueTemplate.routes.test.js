const request = require("supertest");
const app = require("../app");

// Follows tests/app.test.js's existing convention: AUTH_BYPASS_ENABLED=true (set in
// tests/setup.js) still requires a Bearer token, so hitting these routes without one
// exercises "route is mounted and sits behind the auth middleware" without needing a real
// gateway/policy-service round trip (see middlewares/auth.js).
describe("issue-service /api/templates routes", () => {
  it("GET /api/templates requires authentication", async () => {
    const res = await request(app).get("/api/templates");
    expect(res.status).toBe(400);
  });

  it("GET /api/templates/default requires authentication", async () => {
    const res = await request(app).get("/api/templates/default");
    expect(res.status).toBe(400);
  });

  it("GET /api/templates/:templateId requires authentication", async () => {
    const res = await request(app).get("/api/templates/64b000000000000000000000");
    expect(res.status).toBe(400);
  });

  it("POST /api/templates requires authentication", async () => {
    const res = await request(app).post("/api/templates").send({ name: "My view" });
    expect(res.status).toBe(400);
  });

  it("PUT /api/templates/:templateId requires authentication", async () => {
    const res = await request(app)
      .put("/api/templates/64b000000000000000000000")
      .send({ name: "Renamed" });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/templates/:templateId requires authentication", async () => {
    const res = await request(app).delete("/api/templates/64b000000000000000000000");
    expect(res.status).toBe(400);
  });
});

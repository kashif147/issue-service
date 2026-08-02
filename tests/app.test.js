const request = require("supertest");
const app = require("../app");

describe("issue-service app", () => {
  it("GET /health returns 200 UP", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "UP" });
  });

  it("GET /api returns service metadata without auth", async () => {
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("Issue Management Service API");
  });

  it("GET /api/issues requires authentication", async () => {
    const res = await request(app).get("/api/issues");
    expect(res.status).toBe(400);
  });

  it("GET /api/iro-pa-assignments requires authentication", async () => {
    const res = await request(app).get("/api/iro-pa-assignments");
    expect(res.status).toBe(400);
  });
});

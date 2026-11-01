// The two name-lookup clients: bounded timeout, forward the caller's own Authorization (the
// user-service lookup trusts only the verified user JWT), best-effort [] on 4xx/5xx/timeout,
// safe failure logging (code/status only, never the error message, URL or body).
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));
const axios = require("axios");
const userClient = require("../services/userService.client");
const profileClient = require("../services/profileService.client");

const U = "aaaaaaaaaaaaaaaaaaaaaaaa";
const req = { headers: { authorization: "Bearer caller-jwt", "x-jwt-verified": "true", "x-tenant-id": "t-a" } };
let errSpy;
beforeEach(() => { jest.clearAllMocks(); errSpy = jest.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => errSpy.mockRestore());

test("user lookup: POST /api/users/lookup with the caller's Authorization and a bounded timeout", async () => {
  axios.post.mockResolvedValue({ status: 200, data: { data: [{ _id: U, fullName: "Kate" }] } });
  expect(await userClient.lookupUserNames([U, U, null], { req, tenantId: "t-a" })).toEqual([{ _id: U, fullName: "Kate" }]);
  const [url, body, opts] = axios.post.mock.calls[0];
  expect(url).toMatch(/\/api\/users\/lookup$/);
  expect(body).toEqual({ ids: [U] });
  expect(opts.headers.authorization).toBe("Bearer caller-jwt");
  expect(opts.timeout).toBe(userClient.NAME_LOOKUP_TIMEOUT_MS);
  expect(opts.timeout).toBeLessThanOrEqual(3000);
});

test("user lookup: 401/403 (e.g. no verified token) and timeouts -> [], nothing thrown, safe log only", async () => {
  axios.post.mockResolvedValueOnce({ status: 401, data: { error: { code: "VERIFIED_TOKEN_REQUIRED" } } });
  expect(await userClient.lookupUserNames([U], { req: { headers: {} }, tenantId: "t-a" })).toEqual([]);
  axios.post.mockRejectedValueOnce(Object.assign(new Error("timeout of 3000ms exceeded http://user-service:5001/api/users/lookup SECRET"), { code: "ECONNABORTED" }));
  expect(await userClient.lookupUserNames([U], { req, tenantId: "t-a" })).toEqual([]);
  const logged = JSON.stringify(errSpy.mock.calls);
  expect(logged).toMatch(/ECONNABORTED/);
  expect(logged).not.toMatch(/SECRET|user-service:5001|timeout of/);
});

test("profile lookup: bounded timeout, [] on failure, safe log", async () => {
  axios.post.mockRejectedValueOnce(Object.assign(new Error("boom INTERNAL_DETAIL"), { response: { status: 502 } }));
  expect(await profileClient.lookupProfilesByIds([U], { req, tenantId: "t-a" })).toEqual([]);
  expect(axios.post.mock.calls[0][2].timeout).toBeLessThanOrEqual(3000);
  expect(JSON.stringify(errSpy.mock.calls)).not.toMatch(/INTERNAL_DETAIL/);
});

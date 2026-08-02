// Test setup file
process.env.NODE_ENV = "test";
process.env.PORT = "4012";
process.env.MONGO_URI = "mongodb://localhost:27017/issue-service-test";
process.env.AUTH_BYPASS_ENABLED = "true";
process.env.JWT_SECRET = "test-jwt-secret-key";

jest.mock("../rabbitMQ", () => ({
  initEventSystem: jest.fn().mockResolvedValue(),
  setupConsumers: jest.fn().mockResolvedValue(),
  shutdownEventSystem: jest.fn().mockResolvedValue(),
}));

jest.mock("../config/db", () => ({
  mongooseConnection: jest.fn().mockResolvedValue(),
}));

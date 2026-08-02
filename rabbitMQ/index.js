const {
  init,
  publisher,
  consumer,
  shutdown,
} = require("@projectShell/rabbitmq-middleware");
const { createRabbitStructuredLogHandlers } = require("@projectShell/logging-lib");
const bizLogger = require("../config/bizLogger.js");
const issueEventsPublisher = require("./publishers/issue.events.publisher.js");

// issue-service publishes on its own `issues.events` exchange (new and additive - the
// shared middleware merges this with its default exchange list) - see plan §1.3. No
// consumers needed inside issue-service itself for this feature.
async function initEventSystem() {
  try {
    await init({
      url: process.env.RABBIT_URL,
      logger: console,
      structuredLog: createRabbitStructuredLogHandlers(bizLogger),
      prefetch: 10,
      connectionName: "issue-service",
      serviceName: "issue-service",
      exchanges: [{ name: "issues.events", type: "topic", options: { durable: true } }],
    });
    console.log("✅ Event system initialized with middleware");
  } catch (error) {
    console.error("❌ Failed to initialize event system:", error.message);
    throw error;
  }
}

async function setupConsumers() {
  // No consumers needed inside issue-service for this slice (see plan §1.3).
  console.log("✅ No consumers configured for issue-service yet");
}

async function shutdownEventSystem() {
  try {
    await shutdown();
    console.log("✅ Event system shutdown complete");
  } catch (error) {
    console.error("❌ Error during event system shutdown:", error.message);
  }
}

module.exports = {
  init,
  publisher,
  consumer,
  shutdown,
  initEventSystem,
  setupConsumers,
  shutdownEventSystem,
  issueEvents: issueEventsPublisher,
};

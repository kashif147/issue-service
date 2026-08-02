/**
 * Shared best-effort RabbitMQ publish wrapper - a RabbitMQ hiccup must never throw past
 * this point and fail work that has already succeeded (an HTTP response already sent in
 * controllers/issue.controller.js, or a background scan that has already committed its
 * Mongo writes in services/dueDateScheduler.service.js). Extracted here once a second
 * caller needed the identical behavior - both now import this instead of each keeping
 * their own copy.
 */
async function publishSafely(fn, label) {
  try {
    await fn();
  } catch (error) {
    console.error(`[publishSafely] Failed to publish ${label}:`, error.message);
  }
}

module.exports = { publishSafely };

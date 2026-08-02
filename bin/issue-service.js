#!/usr/bin/env node

var app = require("../app");
var debug = require("debug")("issue-service:server");
var http = require("http");
const {
  startDueDateScheduler,
  stopDueDateScheduler,
} = require("../services/dueDateScheduler.service");

var port = normalizePort(process.env.PORT || "4012");
app.set("port", port);

var server = http.createServer(app);

server.listen(port, "0.0.0.0", () => {
  console.log(`Server Running on Port: ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`MongoDB URI configured: ${!!process.env.MONGO_URI}`);

  // Due-date-approaching scheduler (plan §1.4) - started only once the HTTP server is
  // actually listening (mirroring app.js's own "initEventSystem after the app is up"
  // ordering), a single-instance in-process daily interval - see
  // services/dueDateScheduler.service.js for the no-leader-election caveat.
  startDueDateScheduler();
});
server.on("error", onError);
server.on("listening", onListening);

process.on("SIGTERM", () => {
  stopDueDateScheduler();
});
process.on("SIGINT", () => {
  stopDueDateScheduler();
});

function normalizePort(val) {
  var port = parseInt(val, 10);
  if (isNaN(port)) return val;
  if (port >= 0) return port;
  return false;
}

function onError(error) {
  if (error.syscall !== "listen") throw error;
  var bind = typeof port === "string" ? "Pipe " + port : "Port " + port;
  switch (error.code) {
    case "EACCES":
      console.error(bind + " requires elevated privileges");
      process.exit(1);
      break;
    case "EADDRINUSE":
      console.error(bind + " is already in use");
      process.exit(1);
      break;
    default:
      throw error;
  }
}

function onListening() {
  var addr = server.address();
  var bind = typeof addr === "string" ? "pipe " + addr : "port " + addr.port;
  debug("Listening on " + bind);
}

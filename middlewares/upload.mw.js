const multer = require("multer");

// Local copy of profile-service's middlewares/upload.mw.js - same config, kept as its own
// per-service copy per this platform's convention (no service imports another service's
// source directly). Used by the portal comment/attachment endpoint
// (controllers/issuePortal.controller.js#portalAddIssueComment).
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and image uploads are allowed"));
    }
  },
});

module.exports = { upload };

const mongoose = require("mongoose");
const Issue = require("./issue.model");

const CRITERIA_LETTER_STATUSES = ["PENDING", "SENT", "RECEIVED"];
const SOLICITORS = ["O_CONNORS", "OTHER"];
const LEGISLATIONS = ["S55_1_I", "S58", "S55_PPC", "S55_INQUIRY"];

const FtpSchema = new mongoose.Schema({
  aragReferenceNo: { type: String, default: null },
  criteriaLetterStatus: { type: String, enum: CRITERIA_LETTER_STATUSES, default: "PENDING" },

  externalSolicitorInvolved: { type: Boolean, default: false },
  solicitor: { type: String, enum: SOLICITORS, default: null },
  solicitorOther: { type: String, default: null },

  membershipVerified: { type: Boolean, default: false },
  dateInitialPapersReceived: { type: Date, default: null },
  insurerReference: { type: String, default: null },

  legislation: { type: String, enum: LEGISLATIONS, default: null },
  nmbiReference: { type: String, default: null },
});

const Ftp = Issue.discriminator("FTP", FtpSchema);

module.exports = Ftp;
module.exports.CRITERIA_LETTER_STATUSES = CRITERIA_LETTER_STATUSES;
module.exports.SOLICITORS = SOLICITORS;
module.exports.LEGISLATIONS = LEGISLATIONS;

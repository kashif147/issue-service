// Unit tests for models/issue.model.js's ownerRequiredUnlessIrOrPortal pre-validate hook
// (formerly ownerRequiredExceptIr, extended this session to also skip portal-submitted
// issues). Mongoose's .validate() runs pre-validate middleware purely in-process - no live
// DB connection needed (unlike .save()), so this exercises the real hook directly rather
// than mocking it.

const Complaint = require("../models/issue.complaint.model");
const Ir = require("../models/issue.ir.model");

function baseComplaintFields(overrides = {}) {
  return {
    tenantId: "tenant-1",
    dateReceived: new Date(),
    origin: "PORTAL-O",
    complaintType: "MOO",
    ...overrides,
  };
}

describe("issue.model ownerRequiredUnlessIrOrPortal", () => {
  it("rejects a CRM-created COMPLAINT with no owner.userId", async () => {
    const issue = new Complaint(baseComplaintFields());
    await expect(issue.validate()).rejects.toThrow(/owner.userId is required/);
  });

  it("accepts a CRM-created COMPLAINT with owner.userId set", async () => {
    const issue = new Complaint(baseComplaintFields({ owner: { userId: "staff-1" } }));
    await expect(issue.validate()).resolves.toBeUndefined();
  });

  it("accepts a portal-created COMPLAINT with no owner.userId", async () => {
    const issue = new Complaint(baseComplaintFields({ createdViaPortal: true }));
    await expect(issue.validate()).resolves.toBeUndefined();
  });

  it("still requires an owner on a portal-flagged issue if createdViaPortal is explicitly false", async () => {
    const issue = new Complaint(baseComplaintFields({ createdViaPortal: false }));
    await expect(issue.validate()).rejects.toThrow(/owner.userId is required/);
  });

  it("still allows IR with no owner.userId regardless of createdViaPortal (unchanged behavior)", async () => {
    const issue = new Ir({
      tenantId: "tenant-1",
      dateReceived: new Date(),
      origin: "EMAIL-O",
      issueDesignation: "some-designation-lookup-id",
    });
    await expect(issue.validate()).resolves.toBeUndefined();
  });
});

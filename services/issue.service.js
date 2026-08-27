const referenceNumberGenerator = require("./referenceNumberGenerator");
const profileServiceClient = require("./profileService.client");

// issueType -> owner.team, per the plan's auto-routing-on-save pseudocode (§1.2).
const OWNER_TEAM_BY_ISSUE_TYPE = {
  COMPLAINT: "COMPLAINTS",
  FTP: "FTP",
  IR: "IR",
  DP: "DATA_PROTECTION",
};

// issueType -> the RBAC resource slug gating that team's issues (issues-complaints,
// issues-ftp, issues-ir, issues-dataprotection), per the plan's permission-gating section.
const TEAM_RESOURCE_BY_ISSUE_TYPE = {
  COMPLAINT: "issues-complaints",
  FTP: "issues-ftp",
  IR: "issues-ir",
  DP: "issues-dataprotection",
};

function teamResourceForIssueType(issueType) {
  return TEAM_RESOURCE_BY_ISSUE_TYPE[issueType] || null;
}

/**
 * user-service's getUserPermissions collapses a Super User's permissions to the literal
 * wildcard ["*"] rather than every canonical `resource:action` string (see
 * handlers/role.handler.js there) - every permission check across user-service's own PDP
 * (services/policyEvaluationService.js) treats "*" as "matches anything", so any code here
 * doing a literal permissions.includes(`${resource}:action`) check must do the same or an
 * SU (or any other caller whose effective permissions are "*") gets silently treated as
 * having none of them.
 */
function hasPermission(permissions, required) {
  return permissions.includes(required) || permissions.includes("*");
}

/**
 * Which issueTypes the caller may see, derived from which issues-<team>:read resources are
 * present in req.ctx.permissions - never trust the frontend to only request one type (plan
 * §1.2). Callers must always AND this into every list/detail query via
 * `{ issueType: { $in: getAllowedIssueTypes(req) } }`.
 */
function getAllowedIssueTypes(req) {
  const permissions = req?.ctx?.permissions || [];
  return Object.entries(TEAM_RESOURCE_BY_ISSUE_TYPE)
    .filter(([, resource]) => hasPermission(permissions, `${resource}:read`))
    .map(([issueType]) => issueType);
}

/**
 * PUT /issues/:id and PUT /issues/:id/status can't gate on a static route-level resource
 * since the required resource depends on the *loaded* document's issueType - this is the
 * controller-level check the plan calls out as a deliberate deviation from every other
 * route in this codebase (§1.2).
 */
function hasTeamWritePermission(req, issueType) {
  const resource = teamResourceForIssueType(issueType);
  if (!resource) return false;
  const permissions = req?.ctx?.permissions || [];
  return hasPermission(permissions, `${resource}:write`);
}

/**
 * Complaint-against-self hiding (plan §1.2) - row-level, not RBAC-expressible. Excludes any
 * COMPLAINT-typed issue where complaintAgainstUserId === the caller's own userId. Safe to
 * apply unconditionally to every query (list, detail-by-id, activity parent lookups): for
 * every non-COMPLAINT issue complaintAgainstUserId is always null, and null !== userId, so
 * this never filters out anything that isn't a self-targeted complaint. A detail-by-id fetch
 * excluded by this filter must resolve to a plain "not found" (findOne returns null) rather
 * than a 403, so existence is never confirmed to the excluded user.
 */
function withComplaintHideFilter(filter, userId) {
  return { ...filter, complaintAgainstUserId: { $ne: userId } };
}

/**
 * "User Initials" for the IR caseFileNumber format (YY-{initials}-{6digit}) - the
 * requirements doc doesn't specify how initials are derived, only that they identify the
 * logging user. Judgment call: derive from the gateway-forwarded x-user-email header
 * (firstname.lastname@... -> "FL"), since no user "name" claim is forwarded to services
 * (see middlewares/auth.js - only x-user-id/email/type/roles/permissions).
 */
function deriveInitialsFromEmail(email) {
  if (!email) return "XX";
  const local = String(email).split("@")[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase() || "XX";
}

/**
 * First member's display name, used for the auto-generated caseTitle/complainant label
 * ("{contactName} {internalReferenceNumber}", plan §1.1). Best-effort - a profile-service
 * hiccup should never block issue creation, so this swallows its own errors.
 */
async function resolveContactName(memberIds, { req, tenantId } = {}) {
  const primaryMemberId = Array.isArray(memberIds) ? memberIds[0] : memberIds;
  if (!primaryMemberId) return null;
  try {
    const profile = await profileServiceClient.getProfileById(primaryMemberId, { req, tenantId });
    if (!profile) return null;
    const first =
      profile.personalDetails?.firstName || profile.firstName || profile.forename || "";
    const last =
      profile.personalDetails?.surname || profile.surname || profile.lastName || "";
    const name = `${first} ${last}`.trim();
    return name || null;
  } catch (error) {
    console.warn("[issue.service] resolveContactName failed:", error.message);
    return null;
  }
}

/**
 * IR-only: resolve the primary member's IRO userId via the two-hop lookup (profile-service
 * workLocation -> user-service WORKLOC Lookup.officer). services/iroResolution.service.js is
 * owned by a separate, parallel workstream and may not exist in this checkout yet - required
 * lazily (not at module load) so its absence only affects IR auto-routing, not every route
 * that touches issue.service.js. Any failure (module missing, HTTP error, no match) leaves
 * owner.userId null rather than failing the create, per the plan.
 */
async function resolveIroOwnerUserId(primaryMemberId, { req, tenantId } = {}) {
  if (!primaryMemberId) return null;
  try {
    // eslint-disable-next-line global-require
    const iroResolution = require("./iroResolution.service");
    const result = await iroResolution.resolveForProfile(primaryMemberId, tenantId, { req });
    return result?.iroUserId || null;
  } catch (error) {
    console.warn(
      "[issue.service] IRO resolution unavailable, leaving owner.userId null:",
      error.message,
    );
    return null;
  }
}

/**
 * Auto-routing-on-save (plan §1.2): owner.team is always set from issueType. IR additionally
 * resolves owner.userId to the primary member's IRO. FTP is team-level ownership only, no
 * auto-assigned individual, per the doc.
 */
async function autoRouteOwner(issue, { req, tenantId } = {}) {
  issue.owner = issue.owner || {};
  issue.owner.team = OWNER_TEAM_BY_ISSUE_TYPE[issue.issueType] || null;

  if (issue.issueType === "IR") {
    const primaryMemberId = Array.isArray(issue.memberIds) ? issue.memberIds[0] : null;
    issue.owner.userId = await resolveIroOwnerUserId(primaryMemberId, { req, tenantId });
  }
}

/**
 * Reference-number assignment (plan §1.1/§1.2): internalReferenceNumber ("##-YY") always,
 * plus IR's caseFileNumber ("YY-{initials}-{6digit}").
 */
async function assignReferenceNumbers(issue, { tenantId, userInitials } = {}) {
  issue.internalReferenceNumber =
    await referenceNumberGenerator.generateInternalReferenceNumber(tenantId);

  if (issue.issueType === "IR") {
    issue.caseFileNumber = await referenceNumberGenerator.generateCaseFileNumber(
      tenantId,
      userInitials,
    );
  }
}

/** Case Title / Complainant: auto "{contactName} {internalReferenceNumber}" (plan §1.1). */
async function assignAutoTitles(issue, { req, tenantId } = {}) {
  const contactName = await resolveContactName(issue.memberIds, { req, tenantId });
  const label = [contactName, issue.internalReferenceNumber].filter(Boolean).join(" ");
  issue.caseTitle = label || issue.caseTitle || null;
  if (issue.issueType === "COMPLAINT") {
    issue.complainant = label || issue.complainant || null;
  }
}

/**
 * Full create-time orchestration, called by controllers/issue.controller.js before
 * issue.save(): assign reference number(s), auto-route owner, set caseTitle/complainant.
 * Order matters - reference numbers must exist before the auto-title can include one.
 */
async function prepareNewIssue(issue, { req, tenantId, userInitials } = {}) {
  await assignReferenceNumbers(issue, { tenantId, userInitials });
  await autoRouteOwner(issue, { req, tenantId });
  await assignAutoTitles(issue, { req, tenantId });
  return issue;
}

module.exports = {
  OWNER_TEAM_BY_ISSUE_TYPE,
  TEAM_RESOURCE_BY_ISSUE_TYPE,
  teamResourceForIssueType,
  hasPermission,
  getAllowedIssueTypes,
  hasTeamWritePermission,
  withComplaintHideFilter,
  deriveInitialsFromEmail,
  resolveContactName,
  resolveIroOwnerUserId,
  autoRouteOwner,
  assignReferenceNumbers,
  assignAutoTitles,
  prepareNewIssue,
};

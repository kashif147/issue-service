const profileServiceClient = require("./profileService.client");
const userServiceClient = require("./userService.client");

// Display-name hydration for CRM issue responses (GET /issues, /issues/mine, /issues/search,
// /issues/:id). Issues only store ids - memberIds are profile-service profile ids, while
// createdBy / owner.userId / resolvedByUserId / complaintAgainstUserId are user-service user
// ids - so names are resolved per response with one batch call to each owning service
// (forwarding the caller's identity, never a direct DB read - see the no-cross-db-mongo and
// cross-service-auth skills).
//
// Purely additive: every id field is left exactly as stored and the names go into new
// fields alongside them. Best-effort, same principle as issue.service.js's
// resolveContactName: a lookup failure leaves the name fields null rather than failing the
// request.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function validId(id) {
  if (id == null) return null;
  const value = String(id).trim();
  return OBJECT_ID_RE.test(value) ? value : null;
}

const USER_ID_GETTERS = [
  (issue) => issue.createdBy,
  (issue) => issue.owner?.userId,
  (issue) => issue.resolvedByUserId,
  (issue) => issue.complaintAgainstUserId,
];

function profileFullName(profile) {
  const pi = profile?.personalInfo || {};
  const composed = [pi.forename, pi.surname]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return (typeof pi.fullName === "string" && pi.fullName.trim()) || composed || null;
}

function toPlain(issue) {
  if (!issue) return issue;
  return typeof issue.toObject === "function" ? issue.toObject() : { ...issue };
}

/**
 * Returns new plain issue objects with these fields added:
 * - members: [{ profileId, fullName, membershipNumber }] in memberIds order (for a
 *   COMPLAINT, index 0 is the complainant and index 1 the member complained against -
 *   see the frontend's ComplaintFields.jsx)
 * - memberNames: the members' full names, same order (null where unresolved)
 * - complainantName / complaintAgainstName: COMPLAINT only, members[0] / members[1]
 * - createdByName, ownerName, resolvedByName, complaintAgainstUserName: user display names
 */
async function hydrateIssueNames(issues, { req, tenantId } = {}) {
  const list = (Array.isArray(issues) ? issues : []).map(toPlain);
  if (list.length === 0) return list;

  const profileIds = new Set();
  const userIds = new Set();
  for (const issue of list) {
    for (const memberId of Array.isArray(issue.memberIds) ? issue.memberIds : []) {
      const id = validId(memberId);
      if (id) profileIds.add(id);
    }
    for (const getId of USER_ID_GETTERS) {
      const id = validId(getId(issue));
      if (id) userIds.add(id);
    }
  }

  const [profiles, users] = await Promise.all([
    profileIds.size
      ? profileServiceClient.lookupProfilesByIds([...profileIds], { req, tenantId }).catch(() => [])
      : [],
    userIds.size
      ? userServiceClient.lookupUserNames([...userIds], { req, tenantId }).catch(() => [])
      : [],
  ]);

  const profileById = new Map(
    (Array.isArray(profiles) ? profiles : []).map((profile) => [String(profile._id), profile]),
  );
  const userNameById = new Map(
    (Array.isArray(users) ? users : []).map((user) => [
      String(user._id),
      // Display name only; user-service no longer returns email and it is never a fallback.
      (typeof user.fullName === "string" && user.fullName.trim()) || null,
    ]),
  );
  const userName = (id) => {
    const key = validId(id);
    return key ? userNameById.get(key) || null : null;
  };

  return list.map((issue) => {
    const members = (Array.isArray(issue.memberIds) ? issue.memberIds : []).map((memberId) => {
      const profile = profileById.get(String(memberId));
      return {
        profileId: String(memberId),
        fullName: profile ? profileFullName(profile) : null,
        membershipNumber: profile?.membershipNumber || null,
      };
    });
    const hydrated = {
      ...issue,
      members,
      memberNames: members.map((member) => member.fullName),
      createdByName: userName(issue.createdBy),
      ownerName: userName(issue.owner?.userId),
      resolvedByName: userName(issue.resolvedByUserId),
    };
    if (issue.issueType === "COMPLAINT") {
      hydrated.complainantName = members[0]?.fullName || null;
      hydrated.complaintAgainstName = members[1]?.fullName || null;
      hydrated.complaintAgainstUserName = userName(issue.complaintAgainstUserId);
    }
    return hydrated;
  });
}

module.exports = { hydrateIssueNames, profileFullName };

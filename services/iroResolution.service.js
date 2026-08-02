const profileServiceClient = require("./profileService.client");
const lookupServiceClient = require("./lookup.service.client");
const IroPaAssignment = require("../models/iroPaAssignment.model");

// Two-hop IRO resolution (plan §1.1 "IRO resolution - no new mapping model"): the
// workplace -> IRO mapping already exists as user-service's WORKLOC Lookup.officer field,
// already populated by the platform's existing "Assign IRO" flow. This service just
// replicates that existing read, it does not own any new storage for it.
//
//   1. profile-service: Profile.professionalDetails.workLocation (a plain String label)
//   2. user-service: resolve that label to a WORKLOC Lookup, read its .officer

/**
 * Resolves { iroUserId, iroPaUserId } for a given profile. Never throws - a profile
 * missing a work location, a work location with no assigned officer, or either service
 * being unreachable all resolve to nulls rather than blocking issue creation (callers,
 * e.g. services/issue.service.js's resolveIroOwnerUserId, already treat a null iroUserId
 * as "leave owner.userId unset").
 */
async function resolveForProfile(profileId, tenantId, { req } = {}) {
  if (!profileId) return { iroUserId: null, iroPaUserId: null };

  const professionalDetails = await profileServiceClient.getProfessionalDetails(profileId, {
    req,
    tenantId,
  });
  const workLocation = professionalDetails?.workLocation;
  if (!workLocation) return { iroUserId: null, iroPaUserId: null };

  const lookup = await lookupServiceClient.findWorkLocationLookup(workLocation, { req, tenantId });
  const officer = lookup?.officer;
  const iroUserId = officer?._id ? String(officer._id) : officer ? String(officer) : null;

  if (!iroUserId) return { iroUserId: null, iroPaUserId: null };

  const iroPaUserId = await resolvePaForIro(iroUserId, tenantId);
  return { iroUserId, iroPaUserId };
}

/**
 * PA of an IRO - genuinely new directory data, not resolvable from any existing platform
 * concept (plan §1.1: no reportsTo/managerId/assistantToUserId field exists on User
 * anywhere). Falls back to the IRO's own userId when no PA is on file, so downstream
 * due-date-approaching notifications (§1.4) always have a recipient rather than silently
 * dropping.
 */
async function resolvePaForIro(iroUserId, tenantId) {
  if (!iroUserId) return null;
  try {
    const assignment = await IroPaAssignment.findOne({ tenantId, iroUserId }).lean();
    return assignment?.paUserId || iroUserId;
  } catch (error) {
    console.warn("[iroResolution.service] resolvePaForIro failed, falling back to IRO:", error.message);
    return iroUserId;
  }
}

module.exports = {
  resolveForProfile,
  resolvePaForIro,
};

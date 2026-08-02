const IroPaAssignment = require("../models/iroPaAssignment.model");
const { AppError } = require("../errors/AppError");

// Simple, admin-managed CRUD (plan §1.1) - the requirements doc doesn't specify a dedicated
// RBAC resource for this, so it's gated at the route level under the base "issues" resource
// (the same one gating POST /issues), not one of the four team-scoped issues-<team>
// resources - this data isn't owned by any single team.

async function list(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const assignments = await IroPaAssignment.find({ tenantId }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: assignments });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list IRO/PA assignments"));
  }
}

async function create(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { iroUserId, paUserId } = req.body || {};
    if (!iroUserId || !paUserId) {
      return next(AppError.badRequest("iroUserId and paUserId are required"));
    }

    const assignment = await IroPaAssignment.create({ tenantId, iroUserId, paUserId });
    return res.status(201).json({ success: true, data: assignment });
  } catch (error) {
    if (error.code === 11000) {
      return next(AppError.conflict("An assignment for this IRO already exists"));
    }
    if (error.name === "ValidationError") {
      return next(AppError.badRequest(error.message));
    }
    return next(AppError.internalServerError(error.message || "Failed to create IRO/PA assignment"));
  }
}

async function update(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { paUserId } = req.body || {};
    if (!paUserId) return next(AppError.badRequest("paUserId is required"));

    const assignment = await IroPaAssignment.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { paUserId } },
      { new: true, runValidators: true },
    );
    if (!assignment) return next(AppError.notFound("Assignment not found"));
    return res.status(200).json({ success: true, data: assignment });
  } catch (error) {
    if (error.name === "CastError") return next(AppError.notFound("Assignment not found"));
    return next(AppError.internalServerError(error.message || "Failed to update IRO/PA assignment"));
  }
}

async function remove(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const assignment = await IroPaAssignment.findOneAndDelete({ _id: req.params.id, tenantId });
    if (!assignment) return next(AppError.notFound("Assignment not found"));
    return res.status(200).json({ success: true, data: assignment });
  } catch (error) {
    if (error.name === "CastError") return next(AppError.notFound("Assignment not found"));
    return next(AppError.internalServerError(error.message || "Failed to delete IRO/PA assignment"));
  }
}

module.exports = { list, create, update, remove };

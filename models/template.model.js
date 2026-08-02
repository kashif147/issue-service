const mongoose = require("mongoose");

// Save-View grid template for the Issues Summary grid - copied field-for-field from
// events-service's models/template.model.js (plan §1.1 "models/template.model.js" /
// §4.4 grid-template-wiring-checklist item 1). Same soft-delete/isDefault/systemDefault
// semantics as every other service implementing this pattern - see
// TEMPLATE_IMPLEMENTATION_PLAYBOOK.md at the repo root for the authoritative map of which
// service owns template storage for which grid.
const TemplateSchema = new mongoose.Schema(
  {
    /** User-provided name for the template (e.g. "My open complaints") */
    name: {
      type: String,
      trim: true,
      default: null,
    },
    templateType: {
      type: String,
      default: "issuessummary",
      trim: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },
    /** When set, templates are scoped to this tenant (CRM gateway). Legacy docs may omit. */
    tenantId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    columns: {
      type: [String],
      default: [],
    },
    columnLabels: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    /** Toolbar filter chip labels in display order (Save View / update template). */
    visibleFilters: {
      type: [String],
      default: [],
    },
    /**
     * User's chosen default (landing) view for this templateType — at most one per user+type+tenant
     * after saves. This is the only field that should drive "default view" in the product.
     */
    isDefault: {
      type: Boolean,
      default: false,
    },
    /**
     * Legacy: optional sort hint; not used in UI. Prefer isDefault for ordering. Kept for old documents.
     */
    pinned: {
      type: Boolean,
      default: false,
    },
    /**
     * True only for the seeded org "system" template row (baseline filters/columns), not a second
     * "default" — do not conflate with isDefault (per-user).
     */
    systemDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    meta: {
      deleted: {
        type: Boolean,
        default: false,
      },
      deletedAt: {
        type: Date,
        default: null,
      },
    },
  },
  { timestamps: true }
);

TemplateSchema.index({ userId: 1, "meta.deleted": 1 });
TemplateSchema.index({ userId: 1, isDefault: 1 });
TemplateSchema.index({ systemDefault: 1, "meta.deleted": 1 });
TemplateSchema.index({ tenantId: 1, userId: 1, "meta.deleted": 1 });
TemplateSchema.index({ tenantId: 1, systemDefault: 1, templateType: 1 });

module.exports = mongoose.model("Template", TemplateSchema);

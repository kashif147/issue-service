const { AppError } = require("../errors/AppError");

// Unlike events-service's eventTemplate.validators.js, this does NOT enforce an allowlist
// of specific filter keys (EVENTS_TEMPLATE_FILTER_KEYS there) - the Issues Summary grid's
// actual filter set is defined on the frontend side (plan §4.4 items 5-6, FilterContext.js/
// filterUtils.js), which is explicitly out of scope for this backend slice. Hardcoding a
// key allowlist here ahead of that frontend work risks rejecting legitimate keys the
// frontend introduces later. Structural validation (operator/shape) still applies.
const ISSUE_TEMPLATE_TYPES = ["issuessummary"];

const FILTER_OPERATOR = {
  EQUAL_TO: "equal_to",
  NOT_EQUAL_TO: "not_equal_to",
  BETWEEN: "between",
  WITHIN: "within",
  MORE_THAN: "more_than",
};

const VALID_OPERATORS = new Set(Object.values(FILTER_OPERATOR));

function validateFilterEntry(key, entry) {
  if (!entry || typeof entry !== "object") {
    throw AppError.badRequest(`Invalid filter entry for "${key}"`);
  }
  if (!VALID_OPERATORS.has(entry.operator)) {
    throw AppError.badRequest(`Invalid operator for filter "${key}"`);
  }
  if (!Array.isArray(entry.values) || entry.values.length === 0) {
    throw AppError.badRequest(`Filter "${key}" requires at least one value`);
  }
}

function validateFilters(filters = {}) {
  if (!filters || typeof filters !== "object") {
    throw AppError.badRequest("filters must be an object");
  }
  for (const [key, entry] of Object.entries(filters)) {
    validateFilterEntry(key, entry);
  }
}

function resolveVisibleFilters(body = {}) {
  if (Array.isArray(body.visibleFilters)) return body.visibleFilters;
  if (Array.isArray(body.meta?.visibleToolbarFilters)) {
    return body.meta.visibleToolbarFilters;
  }
  return [];
}

function validateCreateIssueTemplate(body = {}) {
  const templateType = String(body.templateType || "issuessummary").trim();
  const normalizedType = templateType.toLowerCase();

  if (!ISSUE_TEMPLATE_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`Unsupported templateType: ${templateType}`);
  }

  validateFilters(body.filters || {});

  const columns = Array.isArray(body.columns) ? body.columns : [];
  for (const col of columns) {
    if (typeof col !== "string" || !col.trim()) {
      throw AppError.badRequest("columns must be an array of non-empty strings");
    }
  }

  return {
    name: body.name != null && body.name !== "" ? String(body.name).trim() : null,
    templateType: normalizedType,
    filters: body.filters || {},
    columns,
    columnLabels:
      body.columnLabels && typeof body.columnLabels === "object"
        ? body.columnLabels
        : {},
    visibleFilters: resolveVisibleFilters(body),
    isDefault: Boolean(body.isDefault),
    pinned: Boolean(body.pinned),
  };
}

function validateUpdateIssueTemplate(body = {}) {
  const out = {};

  if (body.name !== undefined) {
    out.name = body.name !== "" ? String(body.name).trim() : null;
  }
  if (body.templateType !== undefined) {
    const normalizedType = String(body.templateType).trim().toLowerCase();
    if (!ISSUE_TEMPLATE_TYPES.includes(normalizedType)) {
      throw AppError.badRequest(`Unsupported templateType: ${body.templateType}`);
    }
    out.templateType = normalizedType;
  }
  if (body.filters !== undefined) {
    validateFilters(body.filters);
    out.filters = body.filters;
  }
  if (body.columns !== undefined) {
    if (!Array.isArray(body.columns)) {
      throw AppError.badRequest("columns must be an array");
    }
    out.columns = body.columns;
  }
  if (body.columnLabels !== undefined) {
    out.columnLabels = body.columnLabels;
  }
  if (
    body.visibleFilters !== undefined ||
    body.meta?.visibleToolbarFilters !== undefined
  ) {
    out.visibleFilters = resolveVisibleFilters(body);
  }
  if (body.isDefault !== undefined) {
    out.isDefault = Boolean(body.isDefault);
  }
  if (body.pinned !== undefined) {
    out.pinned = Boolean(body.pinned);
  }

  return out;
}

module.exports = {
  ISSUE_TEMPLATE_TYPES,
  FILTER_OPERATOR,
  validateCreateIssueTemplate,
  validateUpdateIssueTemplate,
};

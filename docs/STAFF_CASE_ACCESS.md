# Staff self-service case access (MembersHub) - permission proposal

Status: **proposal** (2026-10-21). No grant has been run and user-service is unchanged.
Branch `feature/staff-case-lists`.

## What the code requires today

| Route | Route gate | In-controller check |
|---|---|---|
| `GET /issues`, `/search`, `/:id`, `/mine` | `issues:read` | visible types = `issues-<team>:read` held (`getAllowedIssueTypes`); complaint-hide |
| `POST /issues` | `issues:write` | **none**: any `issueType` can be created with base write alone |
| `PUT /issues/:id`, `PUT /:id/status` | `issues:write` | `issues-<team>:write` for the loaded case's type |
| activities / attachments | `issues:read` / `issues:write` | `issues-<team>:write` for writes |

## What the roles hold (from `user-service/scripts/grant-issues-permissions-to-roles.js`)

This is read from the script, not the database. Verify it in DEV before relying on it (query below).

| Role | Base `issues:read/write` | Team grants |
|---|---|---|
| IRO | **probably not**: the base grant goes to `Role.find({category:"CRM"})`, and the script's own header records IRO as `category:"PORTAL"` | complaints, ftp, ir: read+write |
| BO (Branch Officer) | probably not (same category issue) | none |
| RO (Regional Officer) | probably not | none |
| IO / MO / AMO | probably not | complaints (+ IO: ir) |
| GS / DGS | yes (explicit) | all teams |

Implications:
- `GET /issues/mine` as built returns 403 for IRO, BO and RO until they hold `issues:read`.
- Granting IRO `issues:read` would expose **every** COMPLAINT/FTP/IR case in the tenant
  through `GET /issues`, because IRO already holds those team reads. That's the existing
  CRM design, but more than MembersHub needs.
- Granting BO/RO the base and team resources would give them the whole team caseload. That's a broad grant, so it's not proposed.

Read-only check in DEV (user-service DB):

```js
db.roles.find({ code: { $in: ["IRO", "BO", "RO"] } }, { code: 1, category: 1, roleCategory: 1, permissions: 1 })
```

## Proposal: a self-scoped resource

Add one resource, **`issues-own`** (`read`, `write`), with the row-level scope enforced in
issue-service rather than by the team resources:

| Route (new, under `/issues/mine`) | Gate | Row scope (always + tenant + not deleted + complaint-hide) |
|---|---|---|
| `GET /issues/mine` | `issues-own:read` | `createdBy = me` OR `owner.userId = me`, **any** type: a staff member always sees what they logged or were assigned |
| `GET /issues/mine/:id` | same | same |
| `POST /issues/mine` | `issues-own:write` | `issueType` ∈ the tenant's MembersHub case types (config; default `["IR"]`). `createdBy = me`. Owner is auto-routed (IR) or defaults to me |
| `PUT /issues/mine/:id` | `issues-own:write` | `owner.userId = me` (assigned) - creators who aren't the owner are read-only |
| `PUT /issues/mine/:id/status` (complete) | `issues-own:write` | `owner.userId = me`; `CLOSED` requires a resolution as today |
| `POST /issues/mine/:id/activities` | `issues-own:write` | `createdBy = me` OR `owner.userId = me` |

Holders of the existing team resources keep their current routes unchanged.

Grants (by role code, a new `grant-issues-own-permissions-to-roles.js` modelled on the existing
script; the `category` field is unreliable):

| Role | `issues-own:read` | `issues-own:write` |
|---|---|---|
| IRO | yes | yes |
| BO | yes | yes |
| RO | yes | yes |

Nothing else changes: no base `issues:*`, no team resources, no change to any other role.

## Code change once the proposal is accepted

1. `/mine` route gate becomes `requirePermission("issues-own", "read")`. The policy middleware only
   supports one resource per route (`requirePermission(resource, action)`), so CRM caseworkers who
   also want `/mine` get `issues-own:read` too; it widens nothing for them.
2. `listMyIssues` drops the team-type restriction for its created/assigned scope (it currently
   reuses `baseListFilter`), keeping tenant, not-deleted and complaint-hide.
3. Add `/mine/:id`, `POST /mine`, `PUT /mine/:id`, `PUT /mine/:id/status` and
   `POST /mine/:id/activities`, sharing the existing services. Write checks are row-level
   (`owner.userId === req.ctx.userId`) instead of `hasTeamWritePermission`.
4. Tests: an A/B tenant matrix for every new route; creator-not-owner can't update or complete;
   another staff member's case is a 404 (not a 403, so existence isn't confirmed); a
   self-targeted complaint stays hidden; `POST /mine` with a disallowed type is a 400.

Separate existing gap (not caused by this work): `POST /issues` doesn't check
`issues-<team>:write`, so base `issues:write` can create a case of any type.

# Staff self-service case access (MembersHub) - permission proposal

Status: **design approved for review** (decisions 2026-10-21: IR-only creation, created-by/assigned-to reads, owner-only update/complete). No grant has been run and user-service is unchanged.
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
| `POST /issues/mine` | `issues-own:write` | `issueType` must be `IR` (first release; anything else is `400 ISSUE_TYPE_NOT_ALLOWED`). `createdBy = me`. Owner auto-routed to the member's IRO; if none, me |
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

## The missing team-write check

Every issue write path checks `issues-<team>:write` for the case's type, **except
`POST /issues` (`createIssue`)**. It only has the route-level `issues:write`. Checked across
`issue.controller.js` (update, status, delete) and `issueActivity.controller.js` (activity
create/update/delete, attachment upload).

How the design handles it:

1. **`POST /issues/mine`** never relies on the route gate alone. It enforces its own type
   allowlist (`IR`) and the row-level owner rules, so the `issues-own:write` grant can't be
   used to create other types.
2. **`POST /issues` (existing CRM route)**: add
   `if (!issueService.hasTeamWritePermission(req, issueType)) return next(AppError.forbidden(...))`
   after the `issueType` validation, mirroring `updateIssue`. This is a behaviour change for any
   role holding base `issues:write` without the matching team write (per the grant script, every
   `category:"CRM"` role, e.g. REO). It ships with the issues-own change, after the primary
   session confirms nothing relies on the gap, and is listed as a dependency rather than fixed
   unilaterally.

Tests for 2: a base-write-only caller gets 403 for every type; a team writer can create only
their own team's type; GS/DGS (`*` / all teams) are unaffected.

## Base `issues:read` must not expose other staff cases

- IRO/BO/RO get **no** base `issues:*` grant in this design, so `GET /issues`, `/issues/search`
  and `/issues/:id` stay closed to them.
- `issues-own` routes are row-scoped in the query itself (`createdBy`/`owner.userId` = the
  trusted user id), not in the permission. Holding `issues-own:read` never widens a query.
- The `/mine` route already on this branch (`71ed890`) is gated on `issues:read` and filtered by
  the caller's own id, so it shows only their own cases. It switches to `issues-own:read` as part
  of the change below.

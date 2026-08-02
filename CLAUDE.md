# CLAUDE.md

`issue-service` owns Issue Management for the membership platform — Complaints, Fitness to
Practice, Industrial Relations, and Data Protection cases, plus their activity timelines,
IRO/PA assignments, and case templates. It owns its own MongoDB via Mongoose. Runs on port
`4012` (see `docker-compose.yml` / `package.json`'s `docker:run`).

This service is **CommonJS** (`require`/`module.exports`), not ESM — `app.js` and every
controller/service/model use `require(...)` throughout.

## Commands

```bash
npm start                # node bin/issue-service.js
npm run dev               # nodemon
npm test                  # jest (all tests)
npm test -- <pattern>     # jest, filter by test file/name pattern
npm run test:watch
npm run test:coverage
```

`npm run lint` and `npm run build` are no-op placeholders
(`"No linting/build configured yet"` / `"No build step required"`) — don't expect either to
catch anything. Tests live under `tests/` and match `**/tests/**/*.test.js` (see
`package.json`'s `jest` block); `tests/setup.js` is the shared Jest bootstrap.

`scripts/seed-grid-system-default-template.js` seeds the grid template's system default —
run with `node scripts/seed-grid-system-default-template.js` directly, not via npm.

## Response envelope

`middlewares/response.mw.js` here is its own shape, different from both events-service's
plain `{success, data}` and the `{status, message, data, timestamp}` convention other
services use — check this file's actual helpers before assuming another service's helper
names apply:

- `res.success(data)` → `{ status: "success", data }`
- `res.fail(message)` / `res.serverError(error)` → `{ success: false, error: { message,
  code, status } }`
- `res.sendResponse(statusCode, data)` → `{ status: statusCode, data }`
- `res.notFoundList(message)` / `res.notFoundRecord(message)` → `200 OK` with
  `{ success: true, data: [] | null, message }` (not a 404 — deliberately)

`middlewares/response.mw.js`'s exported `errorHandler` is separate and handles `AppError`
instances (`errors/AppError.js`), Joi validation errors, Mongoose `CastError`/
`ValidationError`, and generic 4xx/5xx, each serialized slightly differently — read it
before adding a new error path rather than assuming one shape covers all of them.

## Auth

`middlewares/auth.js`'s `authenticate` is mounted globally in `app.js` *after* `/health`
and `GET /api`, so those two are the only unauthenticated routes — same pattern as
events-service. Authorization is a separate concern via `middlewares/policy.middleware.js`
(`@membership/policy-middleware`, `POLICY_SERVICE_URL`).

## Cross-service calls

`services/*.client.js` (`communicationService.client`, `groupService.client`,
`lookup.service.client`, `profileService.client`, `userService.client`) call other services
over HTTP — forward the caller's gateway-verified headers, never a shared API key, per the
platform-wide rule in `backend/.claude/rules/auth-and-cross-service.md`.

## RabbitMQ

`rabbitMQ/publishers/issue.events.publisher.js` publishes issue lifecycle events via
`@projectShell/rabbitmq-middleware`. Check `rabbitmq-middleware/src/publisher.js`'s
`exchangeMapping` before publishing a new routing key — see
`backend/.claude/rules/rabbitmq-gotchas.md`.

## Deployment

Deployed the same way as every other service in this platform: `.github/workflows/deploy.yml`
does SSH + `rsync` + `docker compose build/up` onto the shared VM
(`/home/deploy/membership-platform/issue-service/`) on push to the `gateway` branch. See
`backend/.claude/rules/deployment.md`.

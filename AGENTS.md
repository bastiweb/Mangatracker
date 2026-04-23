# AGENTS.md

## Purpose

This repository contains **Manga Tracker**, a self-hostable web app for managing manga series and books with:

- encrypted SQLite storage
- multi-user auth with roles
- search / sort / genre filtering
- missing-volume tracking
- Hardcover integration
- CSV import/export
- Docker deployment behind Caddy HTTPS

When working in this repo, optimize for:
1. **stability**
2. **security**
3. **small, reviewable changes**
4. **compatibility with the existing architecture**

Do not treat this repo like a greenfield rewrite.

---

## Product and architecture snapshot

The current implementation is intentionally simple and mostly server-driven:

- Runtime: **Node.js 20+**
- Server: **Express**
- Module style: **CommonJS**
- Database: **SQLite with encryption** via `better-sqlite3-multiple-ciphers`
- Main entrypoint: `src/server.js`
- DB bootstrap/migrations: `src/db.js`
- Static frontend: served from `public/`
- Tests: Node integration tests in `tests/integration/api.integration.test.js`
- Deployment: `Dockerfile` + `docker-compose.yml` + `Caddyfile`

Important: preserve this overall shape unless a task explicitly asks for a larger architectural change.

---

## Non-negotiable constraints

### 1) Security is a first-class requirement
This project already includes security-sensitive behavior. Do not weaken it.

Never remove or silently bypass:
- encrypted database requirement (`DB_ENCRYPTION_KEY`)
- same-origin protection for write APIs
- secure session handling
- role checks for admin endpoints
- security headers
- audit logging for admin/security-relevant actions
- backup safety mechanisms

If a change affects auth, sessions, admin actions, backup handling, settings, or database access:
- assume it is security-sensitive
- make the smallest safe change possible
- preserve existing protections
- extend tests when behavior changes

### 2) No unnecessary framework churn
Do **not** introduce large new frameworks or migrations without a clear requirement.

Avoid adding:
- React / Vue / Angular
- TypeScript migration
- Prisma / Sequelize / ORM rewrites
- Redis
- message queues
- background worker stacks
- new CSS/UI frameworks
- alternative databases

Prefer the current stack unless the task explicitly requires something else.

### 3) Keep dependencies minimal
This repo currently has very few runtime dependencies. Keep it that way.

Before adding a dependency:
- prefer built-in Node APIs
- prefer existing code patterns
- justify the dependency in the PR/commit notes
- avoid dependencies for simple parsing, validation, formatting, or utility work

### 4) Do not rewrite large working sections without need
Especially avoid broad rewrites of:
- `src/server.js`
- auth/session logic
- DB initialization/migration logic
- import/export flows
- admin endpoints

Prefer targeted refactors, extracted helper functions, and incremental cleanup.

---

## How to work in this repo

### General approach
- Read the relevant existing code first.
- Match existing naming and patterns.
- Make the smallest change that solves the task.
- Preserve backward compatibility for existing routes and environment variables unless explicitly asked to change them.
- Keep the app runnable with both:
  - local Node execution
  - Docker Compose setup

### Code style
- Use **CommonJS** (`require`, `module.exports`)
- Prefer clear, explicit code over abstraction-heavy patterns
- Keep functions focused
- Reuse existing sanitization/validation helpers when possible
- Keep comments short and high-value
- Do not add noisy comments that restate obvious code

### Error handling
- Fail safely
- Return user-safe error messages from APIs
- Keep detailed internals out of client-facing responses
- Do not swallow important errors silently
- Preserve useful server logs, especially around API failures

---

## Database rules

The DB layer is not just storage; it also contains migration and integrity logic.

When changing database-related behavior:

### Schema / migration changes
- Add migrations in the **existing idempotent style** inside `src/db.js`
- Never assume a fresh database
- Always support existing installations upgrading in place
- Preserve current data whenever possible
- Avoid destructive migrations unless explicitly requested

### FTS / indexes
If a change affects searchable fields:
- update FTS-related logic accordingly
- keep FTS synchronization correct
- avoid breaking existing overview search behavior
- consider index impact on performance

### User isolation
This is a multi-user app.
Any query that reads or mutates user-owned manga/book data must preserve per-user isolation.

Never introduce a change that can expose one user’s library to another user.

---

## Auth, admin, and settings rules

Treat the following areas as high-risk:

- login / logout
- registration flow
- bootstrap flow
- emergency admin password reset
- role changes
- force logout / session invalidation
- Hardcover token storage
- admin audit log
- backup actions

Requirements:
- preserve admin-only checks
- preserve session invalidation where already expected
- preserve auditability for admin/security actions
- do not expose secrets in responses, logs, HTML, or client-side JS
- do not move secret handling to the browser

If you change auth/admin behavior, add or update integration tests.

---

## API rules

This repo already exposes a defined HTTP API surface. Be conservative.

### Preserve existing endpoints and response expectations
Do not rename or remove existing routes casually.

If you add a route:
- keep naming consistent with current conventions
- keep auth requirements explicit
- validate input carefully
- return predictable JSON

### Validation and sanitization
- sanitize all user-controlled text
- validate IDs and numeric input
- validate enums against explicit allowed values
- reject malformed input clearly

### CSV handling
CSV import/export is part of the product.
Preserve:
- user isolation
- duplicate handling
- formula injection protections
- stable field behavior unless explicitly changed

---

## Frontend / UI rules

The frontend is static/server-served, not a SPA framework app.

When editing UI:
- keep it simple
- do not introduce a frontend build pipeline unless required
- preserve current routes/pages
- preserve dark mode and language toggle behavior when touching related UI
- keep admin-only UI inaccessible to non-admins both in UI and server enforcement

Do not rely on frontend checks as the only protection.
Server-side authorization is required.

---

## Docker and deployment rules

The Docker setup is part of the expected product behavior.

When changing deployment-related code:
- keep `Dockerfile`, `docker-compose.yml`, and `Caddyfile` aligned
- preserve HTTPS-through-Caddy local setup
- preserve healthcheck behavior unless there is a clear reason to change it
- preserve persistent data volume behavior
- preserve backup volume behavior

If you add or change environment variables:
- update `.env.example`
- update `README.md`
- use safe defaults where possible
- never hardcode secrets

---

## Testing expectations

Before considering work complete, validate impacted behavior.

Minimum checks:
- run relevant tests
- for backend/API changes, run:
  - `npm run test:integration`

If the change affects:
- auth
- permissions
- user isolation
- import/export
- admin functions
- settings
- backup flows
- security behavior

then update or add integration coverage in `tests/integration/api.integration.test.js`.

If no automated test is added for a risky behavior change, explain why in your summary.

---

## Commands

Use the existing commands and workflows:

### Local
```bash
npm install
npm start
npm run test:integration
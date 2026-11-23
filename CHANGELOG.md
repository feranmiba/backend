# Changelog

All notable changes to the backend API are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Organization invitations: `POST /organizations/:id/invitations` (OWNER/ADMIN) invites an email address with an `ADMIN` or `STAFF` role, and `POST /organizations/invitations/accept` creates the `OrganizationMember`; invites expire after 7 days (`410` once expired)
- `GET /tickets/:ticketId` (owner or organization staff), `GET /tickets/:ticketId/qr` (PNG QR code, owner only) and `GET /tickets/:ticketId/qr-token` (short-lived signed QR token, configurable via `QR_TOKEN_TTL_SECONDS` / `QR_TOKEN_CLOCK_SKEW_SECONDS`) which `GET /tickets/verify/:value` also accepts
- Controller unit specs for events, tickets, organizations and users (route wiring, guards, DTO validation, error propagation) and an auth-flow e2e suite (register, login, `/users/me`)
- Auth (register/login, JWT)
- Organizations, events, ticket types
- Non-custodial ticket lifecycle: issue, purchase, transfer, check-in,
  revoke, resale marketplace
- Users module: profile, wallet connect, email lookup
- Shared `PaginationQueryDto` (`?page=&limit=`, default 20, max 100) and
  `Paginated<T>` response body (`items`, `total`, `page`, `limit`) with a
  `PaginatedResponseInterceptor`; see docs/API.md
- Weak ETags on GET responses; a matching `If-None-Match` returns `304`
- `TRUST_PROXY` env var for Express `trust proxy`; see docs/DEPLOYMENT.md
- `GET /organizations/:id/events` is paginated (`?page=`, `?limit=`) and returns
  `{ items, total, page, limit }`; shared `PaginationQueryDto`
- Cache abstraction with memory and Redis drivers (`CACHE_DRIVER`)
- Optional BullMQ queue for outbound webhooks (`WEBHOOK_QUEUE_ENABLED`, off by default)
- Scheduler module with a sample cron job (`SCHEDULER_ENABLED`)
- `POST /auth/verify-email` and `POST /auth/resend-verification`: registration emails a 24-hour verification token (#599)
- `POST /users/me/stellar-challenge`: issues a single-use message to sign with a Stellar key, to prove control of that account (#595, #596)

### Changed
- **Breaking:** `PATCH /users/me/wallet` requires a `signature` over a challenge from `POST /users/me/stellar-challenge` (#596)
- **Breaking:** `POST /organizations` requires `stellarAccountSignature`, and `PATCH /organizations/:id` requires it whenever `stellarAccount` changes (#595)
- **Breaking:** creating an organization or sending an invitation requires a verified email; event reminders go only to verified addresses. Existing accounts are treated as verified (#599)
- `POST /auth/register` returns `409` for a concurrent duplicate email instead of `500` (#601)
- `GET /events` is paginated and returns `{ items, total, page, limit }`
  instead of a bare array

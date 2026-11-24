# API reference

## Interactive OpenAPI documentation

When `NODE_ENV` is not `production`, Swagger UI is available at `/docs` and
the generated OpenAPI document at `/docs-json`. The schema is generated from
controllers and DTOs at startup. Swagger is disabled in production so the
interactive schema is not exposed publicly.

Every route below is real: paths come from the controllers, request
bodies from the `class-validator` DTOs, and response bodies from what the
services return. When they drift, the generated Bruno collection under
[`bruno/`](bruno/README.md) fails CI, so treat this file and that
collection as two views of the same source.

Paths are shown without a prefix. When `API_PREFIX` is set (e.g.
`api/v1`), every route except `GET /health` is served under it — see
`docs/CONFIGURATION.md`.

The examples assume:

```bash
API=http://localhost:3000
TOKEN=<accessToken from /v1/auth/login>
```

## Pagination

Offset-paginated listings take `?page=&limit=` (`PaginationQueryDto`,
`src/common/dto/pagination-query.dto.ts`):

| Param | Default | Rules |
|---|---|---|
| `page` | `1` | integer ≥ 1 (1-based) |
| `limit` | `20` | integer 1–100 |

An out-of-range value is rejected with `400`. The response body is a
`Paginated<T>` (`src/common/pagination/paginated.ts`). `page` is also capped at 100000:

```json
{ "items": [ ... ], "total": 57, "page": 2, "limit": 20 }
```

`total` counts matching rows across all pages. A page past the end
returns `items: []` with the real `total`.

Currently paginated: `GET /v1/events` (published events, ordered by
`startsAt` then `id` so rows don't shift between pages).
`GET /tickets/resale` uses cursor pagination instead
(`?cursor=&limit=` → `{ items, nextCursor, limit }`).

To paginate a new endpoint, accept `@Query() query: PaginationQueryDto`,
have the service return `prisma.$transaction([findMany({ ...toSkipTake(query) }), count()])`,
and add `PaginatedResponseInterceptor` to the handler's `@UseInterceptors(...)`. The
interceptor turns the `[items, total]` result into a `Paginated<T>` body.
Handlers can also build the body directly with `paginate(items, total, query)`.

## Conditional GET (ETags)

Every `GET` response carries a weak `ETag` (`W/"..."`), computed by
Express from the response body (`app.set('etag', 'weak')` in
`src/app.setup.ts`). A client that re-sends it as `If-None-Match` gets
`304 Not Modified` with an empty body while the response is unchanged,
so polling `GET /v1/events` does not re-download an identical list:

```http
GET /v1/events
→ 200  ETag: W/"1a2-Lx0..."

GET /v1/events
If-None-Match: W/"1a2-Lx0..."
→ 304  (no body)
```

The ETag is a hash of the serialized response, so it changes whenever
any event on the page, or the page's `total`, changes. The server still
runs the query to compute it: the saving is bandwidth and client-side
parsing, not database work.

## Conventions

**Versioning.** All routes live under `/v1` (URI versioning, default
version `1`).

**Authentication.** Everything except `/v1/health`, `/v1/industries`,
`/v1/auth/*`, `GET /v1/events`, `GET /v1/events/slug/:slug`,
`GET /v1/events/:eventId` and
`/v1/stellar/*` needs `Authorization: Bearer <JWT>`. Scanner devices
authenticate `POST /v1/tickets/:ticketId/scanner-check-in` with their own
device token instead (see that route).

**Bodies.** Send `Content-Type: application/json`. The global
`ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted` and
`transform`, so a property that is not in the DTO is a 400, not ignored,
and query-string numbers are coerced.

**Big numbers.** Prices and on-chain ids are `BigInt` columns
(`price`, `chainEventId`, `chainTicketId`, `royaltyFee`,
`sellerProceeds`). They are strings in JSON both ways: send `"2500000"`,
receive `"2500000"`. Prices are in the settlement token's smallest unit.

**Dates.** ISO-8601 strings in UTC, e.g. `2026-12-01T20:00:00.000Z`.

**Status codes.** `POST` returns `201` unless noted, `GET`, `PATCH` and
`DELETE` return `200`. A handler that returns nothing sends an empty
body with that status.

**Idempotency.** Every `build` endpoint (`POST /v1/tickets/issue`,
`purchase`, `:ticketId/transfer`, `check-in`, `revoke`, `list-resale`,
`cancel-resale`, `buy-resale`) accepts an optional `Idempotency-Key`
header. A retry with the same key from the same user within
`IDEMPOTENCY_KEY_TTL_MINUTES` (default 15) replays the first response
instead of building a second envelope.

**The build / confirm pair.** Each on-chain action is two calls. The
`build` call returns `{ "unsignedXdr": "AAAAAgAA..." }`, the caller's
wallet signs it, and the matching `confirm-*` call takes the result back
as `signedXdr`. Every `confirm-*` body extends `ConfirmSignedTxDto`:

| field | type | rules |
|---|---|---|
| `signedXdr` | string | required, the wallet-signed envelope, unmodified |
| `txHash` | string | optional, 64 hex characters, when the client already knows the hash |

The examples below abbreviate XDR as `"AAAAAgAA..."`.

**Errors.** Four shapes, all JSON:

```jsonc
// 400 from ValidationPipe: message is an array, one entry per failed rule
{ "statusCode": 400, "message": ["toPublicKey must be a valid Stellar public key (G...)", "property foo should not exist"], "error": "Bad Request" }

// 401 / 403 / 404 / 409 thrown by a service
{ "statusCode": 404, "message": "Ticket not found", "error": "Not Found" }
{ "statusCode": 401, "message": "Unauthorized" }

// domain errors carry a stable code
{ "statusCode": 409, "code": "TICKET_TYPE_SOLD_OUT", "message": "This ticket type is sold out" }
{ "statusCode": 400, "code": "LISTING_INACTIVE", "message": "This ticket is not listed for resale" }

// database errors are mapped, never leaked
{ "statusCode": 409, "code": "PRISMA_P2002", "message": "A record with this value already exists" }
{ "statusCode": 500, "code": "INTERNAL_ERROR", "message": "Internal server error" }
```

See [ERROR_HANDLING.md](ERROR_HANDLING.md).

**Interactive docs.** Outside production, Swagger UI is served at `/docs`.

## Health and reference data

### `GET /v1/health`

Public liveness probe.

```bash
curl -s "$API/v1/health"
```

```json
{ "status": "ok", "service": "stellar-tickets-backend" }
```

### `GET /v1/industries`

Public. The `Industry` enum used by `Organization.industry` and
`Event.category`.

```bash
curl -s "$API/v1/industries"
```

```json
["CONCERTS", "FLIGHTS", "SPORTS", "FESTIVALS", "CONFERENCES", "BUS", "MOVIE_THEATERS", "MUSEUMS", "TOURIST_ATTRACTIONS", "PUBLIC_TRANSPORT", "UNIVERSITIES", "CORPORATE_EVENTS"]
```

## Auth

### `POST /v1/auth/register`

Public. Creates an `ATTENDEE` account and returns a JWT.

| field | type | rules |
|---|---|---|
| `email` | string | required, valid email |
| `password` | string | required, at least 10 characters |
| `name` | string | required, 1 to 256 characters after trimming |

```bash
curl -s -X POST "$API/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple","name":"Ada Lovelace"}'
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "9d3a5c1e-7b2f-4e8a-9c6d-1f2e3a4b5c6d", "email": "ada@example.com", "name": "Ada Lovelace", "role": "ATTENDEE" }
}
```

`409` when the email is already registered.

### `POST /v1/auth/login`

Public. Returns `200`.

| field | type | rules |
|---|---|---|
| `email` | string | required, valid email |
| `password` | string | required |

```bash
curl -s -X POST "$API/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-battery-staple"}'
```

Same body as register. `401` on a wrong email or password.

## Users

### `GET /v1/users/me`

```bash
curl -s "$API/v1/users/me" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "9d3a5c1e-7b2f-4e8a-9c6d-1f2e3a4b5c6d",
  "email": "ada@example.com",
  "name": "Ada Lovelace",
  "role": "ATTENDEE",
  "stellarPublicKey": "GBAHZWO3UI3GAHPQCPSW6IR5N7HJ4UBRZNAFMSYB6DAKVNHQDOZIV2YJ",
  "createdAt": "2026-09-27T12:00:00.000Z"
}
```

### `PATCH /v1/users/me/wallet`

Links the caller's Stellar account. Required before any ticket action.

| field | type | rules |
|---|---|---|
| `stellarPublicKey` | string | required, `G...` ed25519 public key with a valid checksum |

```bash
curl -s -X PATCH "$API/v1/users/me/wallet" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stellarPublicKey":"GBAHZWO3UI3GAHPQCPSW6IR5N7HJ4UBRZNAFMSYB6DAKVNHQDOZIV2YJ"}'
```

```json
{ "id": "9d3a5c1e-7b2f-4e8a-9c6d-1f2e3a4b5c6d", "stellarPublicKey": "GBAHZWO3UI3GAHPQCPSW6IR5N7HJ4UBRZNAFMSYB6DAKVNHQDOZIV2YJ" }
```

`409` when another account already uses that wallet.

### `PATCH /v1/users/me`

Updates the caller's display name and returns the updated profile.

| field | type | rules |
|---|---|---|
| `name` | string | required, 1 to 256 characters after trimming |

```bash
curl -s -X PATCH "$API/v1/users/me" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace"}'
```

### `GET /v1/users/lookup?email=`

Resolves a recipient before an issue or transfer. `email` must be a
valid email address.

```bash
curl -s "$API/v1/users/lookup?email=grace@example.com" -H "Authorization: Bearer $TOKEN"
```

```json
{ "id": "5e2b9f0c-1a3d-4b7e-8f9a-0c1d2e3f4a5b", "name": "Grace Hopper", "email": "grace@example.com", "stellarPublicKey": "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL" }
```

`404` when no account has that email.

## Organizations

An organization row looks like this everywhere it is returned:

```json
{
  "id": "2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b",
  "name": "Fillmore Live",
  "slug": "fillmore-live",
  "industry": "CONCERTS",
  "stellarAccount": "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG",
  "logoUrl": null,
  "websiteUrl": "https://fillmore.example.com",
  "deletedAt": null,
  "createdAt": "2026-09-27T12:05:00.000Z",
  "updatedAt": "2026-09-27T12:05:00.000Z"
}
```

### `POST /v1/organizations`

Creates the organization, makes the caller its `OWNER`, and promotes an
`ATTENDEE` caller to `ORGANIZER`.

| field | type | rules |
|---|---|---|
| `name` | string | required, 2 to 256 characters after trimming |
| `slug` | string | required, lowercase letters, digits and single hyphens, up to 128 characters, unique |
| `industry` | string | required, one of `GET /v1/industries` |
| `stellarAccount` | string | required, the organizer's `G...` public key that signs issue, check-in and revoke transactions |
| `logoUrl` | string | optional, URL with protocol |
| `websiteUrl` | string | optional, URL with protocol |

```bash
curl -s -X POST "$API/v1/organizations" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Fillmore Live","slug":"fillmore-live","industry":"CONCERTS","stellarAccount":"GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG","websiteUrl":"https://fillmore.example.com"}'
```

`409` when the slug is taken.

### `GET /v1/organizations/mine`

Organizations the caller belongs to, newest first, soft-deleted ones
excluded. Returns an array of organization rows.

```bash
curl -s "$API/v1/organizations/mine" -H "Authorization: Bearer $TOKEN"
```

### `GET /v1/organizations/:id`

One organization row. `404` when missing or soft-deleted.

```bash
curl -s "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b" -H "Authorization: Bearer $TOKEN"
```

### `DELETE /v1/organizations/:id`

Soft delete (members only). Returns the row with `deletedAt` set.

```bash
curl -s -X DELETE "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b" -H "Authorization: Bearer $TOKEN"
```

### `POST /v1/organizations/:id/restore`

Clears `deletedAt` (members only). Returns the row.

```bash
curl -s -X POST "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/restore" -H "Authorization: Bearer $TOKEN"
```

### `POST /v1/organizations/:id/invitations`

Invites an email address to join the organization (`OWNER`/`ADMIN` only).
The person doesn't need an account yet. The raw `token` is returned **once**;
only its hash is stored, so deliver it to the invitee yourself (e.g. in an
accept link). Invites expire 7 days after creation.

| field | type | rules |
|---|---|---|
| `email` | string | required, trimmed and lower-cased |
| `role` | string | optional, `ADMIN` or `STAFF` (default `STAFF`) |

```bash
curl -s -X POST "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/invitations" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"grace@example.com","role":"ADMIN"}'
```

```json
{
  "invitation": {
    "id": "7a1c3e5f-2b4d-4c6e-8f0a-1b2c3d4e5f6a",
    "organizationId": "2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b",
    "email": "grace@example.com",
    "role": "ADMIN",
    "invitedById": "5e2b9f0c-1a3d-4b7e-8f9a-0c1d2e3f4a5b",
    "expiresAt": "2026-10-25T12:00:00.000Z",
    "acceptedAt": null,
    "acceptedById": null,
    "createdAt": "2026-10-18T12:00:00.000Z"
  },
  "token": "inv_3f9c…"
}
```

`403` when the caller isn't an `OWNER`/`ADMIN`, `404` when the organization is
missing or soft-deleted, `409` when that email already belongs to a member.

### `POST /v1/organizations/invitations/accept`

Accepts an invite as the signed-in user, whose account email must match the
invite's. Creates the `OrganizationMember` with the invited role and promotes
an `ATTENDEE` to `ORGANIZER`. Returns the membership row.

| field | type | rules |
|---|---|---|
| `token` | string | required, the token from the invite |

```bash
curl -s -X POST "$API/v1/organizations/invitations/accept" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"token":"inv_3f9c…"}'
```

`410` when the invite has expired, `404` for an unknown token or a
soft-deleted organization, `403` when the email doesn't match, `409` when the
invite was already accepted or the caller is already a member.

## Webhooks

All three routes require membership in `:organizationId`. See
[WEBHOOKS.md](WEBHOOKS.md) for delivery and signing.

### `POST /v1/organizations/:organizationId/webhooks`

| field | type | rules |
|---|---|---|
| `url` | string | required, `http` or `https` URL |
| `events` | string | optional, event filter, up to 512 characters; defaults to `*` |
| `secret` | string | optional, up to 256 characters; generated (32 random bytes, hex) when omitted |

```bash
curl -s -X POST "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/webhooks" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/webhook","events":"ticket.issued,ticket.checked_in"}'
```

```json
{
  "id": "5d7f9b1c-3e4a-4b6c-8d0e-1f2a3b4c5d6e",
  "organizationId": "2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b",
  "url": "https://example.com/webhook",
  "secret": "3f9c1b2a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
  "events": "ticket.issued,ticket.checked_in",
  "isActive": true,
  "createdAt": "2026-09-27T12:10:00.000Z",
  "updatedAt": "2026-09-27T12:10:00.000Z"
}
```

### `GET /v1/organizations/:organizationId/webhooks`

Array of endpoint rows, newest first.

```bash
curl -s "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/webhooks" -H "Authorization: Bearer $TOKEN"
```

### `DELETE /v1/organizations/:organizationId/webhooks/:webhookId`

Returns the deleted row. `404` when the endpoint is not in that
organization.

```bash
curl -s -X DELETE "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/webhooks/5d7f9b1c-3e4a-4b6c-8d0e-1f2a3b4c5d6e" \
  -H "Authorization: Bearer $TOKEN"
```

## Events

An event row:

```json
{
  "id": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
  "organizationId": "2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b",
  "name": "Launch Night",
  "category": "CONCERTS",
  "venue": "The Fillmore",
  "startsAt": "2026-12-01T20:00:00.000Z",
  "endsAt": "2026-12-01T23:00:00.000Z",
  "chainEventId": null,
  "publishedTxHash": null,
  "maxResaleMultiplierBps": 11000,
  "royaltyBps": 500,
  "status": "DRAFT",
  "deletedAt": null,
  "createdAt": "2026-09-27T12:15:00.000Z",
  "updatedAt": "2026-09-27T12:15:00.000Z"
}
```

A ticket type row:

```json
{
  "id": "4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e",
  "eventId": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
  "name": "General Admission",
  "price": "2500000",
  "quantityTotal": 500,
  "quantityIssued": 0,
  "saleStartsAt": null,
  "saleEndsAt": null,
  "isHidden": false,
  "createdAt": "2026-09-27T12:16:00.000Z"
}
```

### `GET /v1/events`

Public marketplace listing: one page (`?page=&limit=`, see
[Pagination](#pagination)) of `PUBLISHED` events of live organizations,
soonest first, each with its visible ticket types and the organizer's
name and slug. Served with `Cache-Control: public, max-age=60, s-maxage=300`
and an application cache (`CACHE_TTL_SECONDS`).

Optional filters, combined with AND (invalid values return `400`):

| Param      | Description                                                         |
| ---------- | ------------------------------------------------------------------- |
| `q`        | Case-insensitive substring of the event name or venue (1–100 chars) |
| `category` | One of the `Industry` values, e.g. `CONCERTS`                       |
| `from`     | ISO 8601; only events with `startsAt >= from`                       |
| `to`       | ISO 8601; only events with `startsAt <= to`; must not precede `from` |

```bash
curl -s "$API/v1/events?page=1&limit=20"
curl -s "$API/v1/events?q=jazz&category=CONCERTS&from=2026-11-01T00:00:00Z&to=2026-11-30T23:59:59Z"
```

```json
{
  "items": [
  {
    "id": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
    "name": "Launch Night",
    "slug": "launch-night-2026-12-01-7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
    "description": "A night of live music at The Fillmore.",
    "imageUrl": "https://cdn.example.com/launch-night.jpg",
    "timezone": "America/Los_Angeles",
    "status": "PUBLISHED",
    "chainEventId": "42",
    "publishedTxHash": "abababababababababababababababababababababababababababababababab",
    "ticketTypes": [{ "id": "4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e", "name": "General Admission", "price": "2500000", "quantityTotal": 500, "quantityIssued": 12, "isHidden": false }],
    "organization": { "name": "Fillmore Live", "slug": "fillmore-live" }
  }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

(Other event columns omitted here for brevity; the response carries the
full row.)

### `GET /v1/events/slug/:slug`

Looks up an event using its shareable slug, generated from its name and start
date. Published events are public; non-published events are visible only to
members of their owning organization. Missing, deleted, and unauthorized
events return `404`.

```bash
curl -s "$API/v1/events/slug/launch-night-2026-12-01-7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c"
```

### `GET /v1/events/:eventId`

One event row with its `organization` row embedded. `PUBLISHED` events are
public; a `DRAFT` (or any non-published) event is visible only to members of
its owning organization — everyone else, signed in or not, gets `404` so an
unannounced event's existence isn't leaked. `404` when missing.

```bash
curl -s "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c"
```

### `GET /v1/organizations/:organizationId/events`

Members only. Paginated, newest first, soft-deleted events excluded.

| query | type | rules |
|---|---|---|
| `status` | string | optional, `DRAFT`, `PUBLISHED` or `CANCELLED` |
| `page` | integer | optional, 1-based, default 1, max 100000 |
| `limit` | integer | optional, default 20, 1 to 100 |

```bash
curl -s "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/events?status=DRAFT&page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "items": [{ "id": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c", "name": "Launch Night", "status": "DRAFT", "ticketTypes": [] }],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### `GET /v1/organizations/:organizationId/events/summary`

Members only. Counts of the organization's events per status, soft-deleted events excluded. Every status is returned, including zeros.

```bash
curl -s "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/events/summary" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "total": 4,
  "byStatus": { "DRAFT": 3, "PUBLISHED": 1, "CANCELLED": 0 }
}
```

### `POST /v1/organizations/:organizationId/events`

Members only. Creates a `DRAFT` event.

| field | type | rules |
|---|---|---|
| `name` | string | required, 2 to 256 characters after trimming |
| `description` | string | required, 1 to 5000 characters after trimming |
| `imageUrl` | string or null | optional, absolute URL when provided |
| `category` | string | required, an `Industry` value |
| `venue` | string | required, 1 to 256 characters after trimming |
| `timezone` | string | required, valid IANA time-zone identifier |
| `startsAt` | date | required, not more than 60 seconds in the past |
| `endsAt` | date | optional |
| `maxResaleMultiplierBps` | integer | optional, 10000 to 50000, default 11000 (resale capped at 110% of face value) |
| `royaltyBps` | integer | optional, 0 to 2000, default 500 (5% of each resale to the organizer) |

```bash
curl -s -X POST "$API/v1/organizations/2c7e4a10-5b6d-4f8e-9a1b-3c4d5e6f7a8b/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Launch Night","description":"A night of live music at The Fillmore.","imageUrl":"https://cdn.example.com/launch-night.jpg","category":"CONCERTS","venue":"The Fillmore","timezone":"America/Los_Angeles","startsAt":"2026-12-01T20:00:00.000Z","endsAt":"2026-12-01T23:00:00.000Z","maxResaleMultiplierBps":11000,"royaltyBps":500}'
```

Returns the event row.

### `POST /v1/events/:eventId/ticket-types`

Members only. `400` unless the event is still a `DRAFT` — once published the
sellable inventory is mirrored on-chain, so new ticket types would drift the
two apart.

| field | type | rules |
|---|---|---|
| `name` | string | required, 1 to 256 characters after trimming |
| `price` | string | required, digits only, no sign, no leading zeros, up to 39 digits |
| `quantityTotal` | integer | required, positive |
| `saleStartsAt` | date | optional |
| `saleEndsAt` | date | optional, must be after `saleStartsAt` when both are set |
| `isHidden` | boolean | optional, default `false`; hidden types are left out of `GET /v1/events` |

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/ticket-types" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"General Admission","price":"2500000","quantityTotal":500}'
```

Returns the ticket type row.

### `PATCH /v1/events/:eventId/ticket-types/:ticketTypeId`

Members only. Updates a ticket type's total inventory. The value may equal
`quantityIssued`, but cannot be lower; an attempted reduction below the
issued count returns `409`.

| field | type | rules |
|---|---|---|
| `quantityTotal` | integer | required, positive and at least `quantityIssued` |

```bash
curl -s -X PATCH "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/ticket-types/4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"quantityTotal":750}'
```

### `POST /v1/events/:eventId/publish`

Members only. Build step: reserves a `chainEventId` and returns the
unsigned `create_event` envelope for the organization's Stellar account
to sign. `400` unless the event is a `DRAFT` that was never confirmed
on-chain and has no pending reservation, `409` until it has at least one
ticket type. A reservation stays pending for the envelope's time bound
(`TRANSACTION_BUILD_TIMEOUT_SECONDS`); if it was never confirmed, the next
call reuses the same `chainEventId` and returns a fresh envelope.

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/publish" -H "Authorization: Bearer $TOKEN"
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

### `POST /v1/events/:eventId/confirm-publish`

Members only. Relays the signed envelope, reads the event back from the
contract to confirm the id and organizer match, then sets
`status: PUBLISHED` and `publishedTxHash`. `409` before anything is
submitted unless the event is still a `DRAFT`.

| field | type | rules |
|---|---|---|
| `signedXdr` | string | required |
| `txHash` | string | optional, 64 hex characters |

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/confirm-publish" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"signedXdr":"AAAAAgAA..."}'
```

Returns the event row with `status: "PUBLISHED"`, `chainEventId: "42"`
and `publishedTxHash` set.

### `POST /v1/events/:eventId/unpublish`

Members only. Back to `DRAFT`. `400` unless `PUBLISHED`, `409` once any
ticket exists.

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/unpublish" -H "Authorization: Bearer $TOKEN"
```

### `DELETE /v1/events/:eventId` and `POST /v1/events/:eventId/restore`

Members only. Soft delete and restore; both return the event row.

```bash
curl -s -X DELETE "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/restore" -H "Authorization: Bearer $TOKEN"
```

## Gates

Members of the event's organization only. A gate is a named entrance
that check-ins can be attributed to.

### `POST /v1/events/:eventId/gates`

| field | type | rules |
|---|---|---|
| `name` | string | required, 1 to 256 characters after trimming |

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/gates" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Front Door"}'
```

```json
{ "id": "8c0e2a4b-6d1f-4c3e-9a5b-7d8e9f0a1b2d", "eventId": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c", "name": "Front Door", "createdAt": "2026-09-27T12:20:00.000Z" }
```

### `GET /v1/events/:eventId/gates`

Array of gate rows, oldest first.

```bash
curl -s "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/gates" -H "Authorization: Bearer $TOKEN"
```

### `DELETE /v1/events/:eventId/gates/:gateId`

`200` with an empty body. `404` when the gate is not on that event.

```bash
curl -s -X DELETE "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/gates/8c0e2a4b-6d1f-4c3e-9a5b-7d8e9f0a1b2d" -H "Authorization: Bearer $TOKEN"
```

## Promo codes

Create, list and revoke need membership in the event's organization.
Preview is for any signed-in buyer.

### `POST /v1/events/:eventId/promo-codes`

| field | type | rules |
|---|---|---|
| `code` | string | required, 3 to 32 of `A-Z`, `0-9`, `_`, `-`; unique per event |
| `discountType` | string | required, `PERCENT` or `FIXED` |
| `discountValue` | integer | required, at least 1; basis points (0 to 10000) for `PERCENT`, a smallest-unit amount for `FIXED` |
| `maxRedemptions` | integer | optional, at least 1 |
| `expiresAt` | string | optional, ISO-8601 |
| `isActive` | boolean | optional, default `true` |

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/promo-codes" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"EARLYBIRD","discountType":"PERCENT","discountValue":2000,"maxRedemptions":100,"expiresAt":"2026-11-01T00:00:00.000Z"}'
```

```json
{
  "id": "3a5c7e9b-1d2f-4e4a-8c6b-9d0e1f2a3b4c",
  "eventId": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
  "code": "EARLYBIRD",
  "discountType": "PERCENT",
  "discountValue": 2000,
  "maxRedemptions": 100,
  "redemptionCount": 0,
  "expiresAt": "2026-11-01T00:00:00.000Z",
  "isActive": true,
  "createdAt": "2026-09-27T12:25:00.000Z",
  "updatedAt": "2026-09-27T12:25:00.000Z"
}
```

### `GET /v1/events/:eventId/promo-codes`

Array of promo code rows, newest first.

```bash
curl -s "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/promo-codes" -H "Authorization: Bearer $TOKEN"
```

### `POST /v1/events/:eventId/promo-codes/preview`

Prices a code for the caller against a ticket type without redeeming
it. `400` with a reason when the code is unknown, inactive, expired,
exhausted or already used by the caller.

| field | type | rules |
|---|---|---|
| `ticketTypeId` | string | required, UUID |
| `code` | string | required, 3 to 32 characters (case-insensitive) |

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/promo-codes/preview" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ticketTypeId":"4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e","code":"EARLYBIRD"}'
```

```json
{
  "promoCode": { "id": "3a5c7e9b-1d2f-4e4a-8c6b-9d0e1f2a3b4c", "discountType": "PERCENT", "discountValue": 2000 },
  "discountedPrice": "2000000",
  "discountAmount": "500000"
}
```

### `DELETE /v1/events/:eventId/promo-codes/:promoCodeId`

Deactivates the code (`isActive: false`) and returns the row.

```bash
curl -s -X DELETE "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/promo-codes/3a5c7e9b-1d2f-4e4a-8c6b-9d0e1f2a3b4c" -H "Authorization: Bearer $TOKEN"
```

## Scanner devices

Members of the event's organization only. A device token lets a gate
scanner confirm check-ins without a staff JWT.

### `POST /v1/events/:eventId/scanner-devices`

| field | type | rules |
|---|---|---|
| `name` | string | required, 1 to 256 characters after trimming |

```bash
curl -s -X POST "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/scanner-devices" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Front Door Scanner"}'
```

```json
{
  "device": {
    "id": "0b2d4f6a-8c1e-4a3b-9d5f-6e7a8b9c0d2e",
    "eventId": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
    "name": "Front Door Scanner",
    "tokenHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "lastUsedAt": null,
    "revokedAt": null,
    "createdAt": "2026-09-27T12:30:00.000Z"
  },
  "token": "scn_4f1c...e2a9"
}
```

`token` is shown once; only its hash is stored.

### `GET /v1/events/:eventId/scanner-devices`

Array of device rows (without tokens), newest first.

```bash
curl -s "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/scanner-devices" -H "Authorization: Bearer $TOKEN"
```

### `PATCH /v1/events/:eventId/scanner-devices/:deviceId/revoke`

Sets `revokedAt`; the token stops authenticating immediately. Returns
the row.

```bash
curl -s -X PATCH "$API/v1/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/scanner-devices/0b2d4f6a-8c1e-4a3b-9d5f-6e7a8b9c0d2e/revoke" \
  -H "Authorization: Bearer $TOKEN"
```

## Waitlist

Routes live under `/v1/ticket-types/:ticketTypeId/waitlist`. Position
is 1-based FIFO among `WAITING` entries. A waitlist entry row:

```json
{
  "id": "2f4a6c8e-0b1d-4c3e-9a5b-7d8e9f0a1b3e",
  "ticketTypeId": "4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e",
  "userId": "9d3a5c1e-7b2f-4e8a-9c6d-1f2e3a4b5c6d",
  "status": "WAITING",
  "offeredAt": null,
  "offerExpiresAt": null,
  "createdAt": "2026-09-27T12:35:00.000Z",
  "updatedAt": "2026-09-27T12:35:00.000Z"
}
```

### `POST /v1/ticket-types/:ticketTypeId/waitlist`

Joins (or re-joins) the waitlist. `409` while the type still has
capacity or when the caller is already waiting.

```bash
curl -s -X POST "$API/v1/ticket-types/4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e/waitlist" -H "Authorization: Bearer $TOKEN"
```

```json
{ "entry": { "id": "2f4a6c8e-0b1d-4c3e-9a5b-7d8e9f0a1b3e", "status": "WAITING" }, "position": 3 }
```

### `DELETE /v1/ticket-types/:ticketTypeId/waitlist`

Leaves the waitlist; returns the entry with `status: "CANCELLED"`.
`404` when the caller is not `WAITING`.

```bash
curl -s -X DELETE "$API/v1/ticket-types/4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e/waitlist" -H "Authorization: Bearer $TOKEN"
```

### `GET /v1/ticket-types/:ticketTypeId/waitlist/me`

The caller's entry and position, same shape as join.

```bash
curl -s "$API/v1/ticket-types/4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e/waitlist/me" -H "Authorization: Bearer $TOKEN"
```

### `GET /v1/ticket-types/:ticketTypeId/waitlist`

Organizer view (members only): entries oldest first, each with
`user: { id, name, email }`.

```bash
curl -s "$API/v1/ticket-types/4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e/waitlist" -H "Authorization: Bearer $TOKEN"
```

### `POST /v1/ticket-types/:ticketTypeId/waitlist/offer-next`

Members only. Moves the next `count` waiting entries to `OFFERED` with
an expiry window.

| field | type | rules |
|---|---|---|
| `count` | integer | required, 1 to 500 |
| `windowMs` | integer | optional, at least 60000; default 24 hours |

```bash
curl -s -X POST "$API/v1/ticket-types/4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e/waitlist/offer-next" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"count":10,"windowMs":86400000}'
```

Returns the offered entries with `status: "OFFERED"`, `offeredAt` and
`offerExpiresAt` set.

## Tickets

A ticket row, as returned by every ticket-producing route:

```json
{
  "id": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
  "eventId": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c",
  "ticketTypeId": "4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e",
  "ownerId": "9d3a5c1e-7b2f-4e8a-9c6d-1f2e3a4b5c6d",
  "chainTicketId": "7",
  "seat": "A-12",
  "status": "VALID",
  "qrSecret": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  "issuedTxHash": "abababababababababababababababababababababababababababababababab",
  "checkedInAt": null,
  "checkInReason": null,
  "checkedInGateId": null,
  "createdAt": "2026-09-27T12:40:00.000Z",
  "updatedAt": "2026-09-27T12:40:00.000Z"
}
```

`status` is one of `VALID`, `USED`, `REVOKED`, `RESALE`. The flows behind
the build / confirm pairs are drawn in
[ARCHITECTURE.md](ARCHITECTURE.md#ticket-lifecycle).

### `GET /v1/tickets/mine?status=`

The caller's tickets, newest first, each with `event` and `ticketType`
embedded. `status` is optional and must be a `TicketStatus` value;
anything else is a 400.

```bash
curl -s "$API/v1/tickets/mine?status=VALID" -H "Authorization: Bearer $TOKEN"
```

```json
[
  {
    "id": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
    "status": "VALID",
    "seat": "A-12",
    "chainTicketId": "7",
    "event": { "id": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c", "name": "Launch Night", "startsAt": "2026-12-01T20:00:00.000Z" },
    "ticketType": { "id": "4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e", "name": "General Admission", "price": "2500000" }
  }
]
```

### `GET /v1/tickets/by-chain/:chainTicketId`

Staff lookup by on-chain id (members of the ticket's organization). The
row comes with `event` (including `organization`) and `ticketType`.
`404` for an unknown or malformed id.

```bash
curl -s "$API/v1/tickets/by-chain/7" -H "Authorization: Bearer $TOKEN"
```

### `GET /v1/tickets/:ticketId`

One ticket with its `event` (including `organization`) and `ticketType`, for
its owner or members of the event's organization. Anyone else gets `403`;
an unknown id is `404`. Staff do not receive the ticket's `qrSecret`.

```bash
curl -s "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c" -H "Authorization: Bearer $TOKEN"
```

### `GET /v1/tickets/:ticketId/qr`

Owner only (`403` for anyone else, `404` for an unknown id). A `512px` PNG
(`Content-Type: image/png`, `Cache-Control: no-store`) encoding the ticket's
`qrSecret`, ready for a client to display.

```bash
curl -s "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/qr" -H "Authorization: Bearer $TOKEN" -o ticket.png
```

### `GET /v1/tickets/:ticketId/qr-token`

Owner only. A short-lived signed token to render in place of the static
`qrSecret`, so a screenshot of the QR code stops working once the token
expires. Fetch a fresh one before `expiresAt` (`Cache-Control: no-store`).

| Setting | Default | Meaning |
|---|---|---|
| `QR_TOKEN_TTL_SECONDS` | `30` | How long a token lasts |
| `QR_TOKEN_CLOCK_SKEW_SECONDS` | `5` | Extra grace after expiry, for scanners whose clock runs behind |

```bash
curl -s "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/qr-token" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "token": "v1.6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c.1790592030.q2Zk...base64url...Ag",
  "expiresAt": "2026-10-17T12:00:30.000Z",
  "ttlSeconds": 30
}
```

### `GET /v1/tickets/verify/:qrSecret`

Gate verification (members only, rate limited per `SCAN_RATE_LIMIT_*`,
`429` when exceeded). `:qrSecret` is either the ticket's static `qrSecret`
or a rotating token from `GET /v1/tickets/:ticketId/qr-token`; an expired
token (past its expiry plus `QR_TOKEN_CLOCK_SKEW_SECONDS`) is rejected with
`400`, and a forged one is `404`, like an unknown secret. Reads the ticket from the contract, reconciles the
cached status, and falls back to the cached row with `stale: true` when
Soroban RPC is unreachable. `ownerMismatch` is `true` when the recorded
owner's wallet is not `onChainOwner`; the owner is then reconciled to the
account holding that wallet, if there is one, and `ownerName` names them.
It is `false` when `stale` is `true`, since there is nothing to compare.

```bash
curl -s "$API/v1/tickets/verify/c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "ticketId": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
  "eventName": "Launch Night",
  "tier": "General Admission",
  "seat": "A-12",
  "ownerName": "Ada Lovelace",
  "status": "VALID",
  "onChainOwner": "GBAHZWO3UI3GAHPQCPSW6IR5N7HJ4UBRZNAFMSYB6DAKVNHQDOZIV2YJ",
  "ownerMismatch": false,
  "stale": false
}
```

### `GET /v1/tickets/offline-public-keys`

Ed25519 public keys (PEM) keyed by key id, for verifying offline
tokens at a gate with no connectivity. See
[OFFLINE_VERIFICATION.md](OFFLINE_VERIFICATION.md).

```bash
curl -s "$API/v1/tickets/offline-public-keys" -H "Authorization: Bearer $TOKEN"
```

```json
{ "2026-09": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n" }
```

### `GET /v1/tickets/:ticketId/offline-token`

Members only. A signed snapshot of the ticket valid for 12 hours.

```bash
curl -s "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/offline-token" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "payload": { "ticketId": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c", "chainTicketId": "7", "eventId": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c", "status": "VALID", "exp": 1790592000 },
  "kid": "2026-09",
  "signature": "q2Zk...base64url...Ag"
}
```

### Issue

Organizer-authorized issuance for a sale settled off-chain. Members of
the event's organization only; the organization's Stellar account signs.

#### `POST /v1/tickets/issue`

| field | type | rules |
|---|---|---|
| `ticketTypeId` | string | required, UUID |
| `toUserId` | string | required, UUID of the recipient account |
| `toPublicKey` | string | required, must equal the recipient's connected wallet |
| `seat` | string | optional, 1 to 64 characters of letters, digits, spaces, `-`, `/`, `.`; defaults to `unassigned` |

```bash
curl -s -X POST "$API/v1/tickets/issue" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: issue-7f3a' \
  -d '{"ticketTypeId":"4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e","toUserId":"5e2b9f0c-1a3d-4b7e-8f9a-0c1d2e3f4a5b","toPublicKey":"GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL","seat":"A-12"}'
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

`400` when the event is unpublished, sales are closed, or the wallet
does not match; `409` (`TICKET_TYPE_SOLD_OUT`) when the type is full.

#### `POST /v1/tickets/confirm-issue`

Same four fields plus `signedXdr` and optional `txHash`.

```bash
curl -s -X POST "$API/v1/tickets/confirm-issue" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ticketTypeId":"4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e","toUserId":"5e2b9f0c-1a3d-4b7e-8f9a-0c1d2e3f4a5b","toPublicKey":"GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL","seat":"A-12","signedXdr":"AAAAAgAA..."}'
```

Returns the new ticket row. `409` when the seat is already issued for
that event.

### Purchase

The buyer signs with their own wallet.

#### `POST /v1/tickets/purchase`

| field | type | rules |
|---|---|---|
| `ticketTypeId` | string | required, UUID |
| `seat` | string | optional, same rules as issue |
| `promoCode` | string | optional, 3 to 32 characters; priced at build time, redeemed after confirm |

```bash
curl -s -X POST "$API/v1/tickets/purchase" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: buy-91c2' \
  -d '{"ticketTypeId":"4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e","promoCode":"EARLYBIRD"}'
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

#### `POST /v1/tickets/confirm-purchase`

| field | type | rules |
|---|---|---|
| `ticketTypeId` | string | required, UUID |
| `seat` | string | optional |
| `promoCode` | string | optional, 3 to 32 characters |
| `signedXdr` | string | required |
| `txHash` | string | optional, 64 hex characters |

```bash
curl -s -X POST "$API/v1/tickets/confirm-purchase" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ticketTypeId":"4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e","promoCode":"EARLYBIRD","signedXdr":"AAAAAgAA..."}'
```

Returns the new ticket row (`ownerId` is the caller) and emails a
receipt.

### Transfer

The current owner signs.

#### `POST /v1/tickets/:ticketId/transfer`

| field | type | rules |
|---|---|---|
| `toUserId` | string | required, UUID |
| `toPublicKey` | string | required, must equal the recipient's connected wallet |

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/transfer" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"toUserId":"5e2b9f0c-1a3d-4b7e-8f9a-0c1d2e3f4a5b","toPublicKey":"GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL"}'
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

`403` when the caller does not own the ticket.

#### `POST /v1/tickets/:ticketId/confirm-transfer`

Same two fields plus `signedXdr` and optional `txHash`.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/confirm-transfer" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"toUserId":"5e2b9f0c-1a3d-4b7e-8f9a-0c1d2e3f4a5b","toPublicKey":"GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL","signedXdr":"AAAAAgAA..."}'
```

Returns the ticket row with the new `ownerId` and `status: "VALID"`.

### Check-in

Members of the event's organization; the organization's Stellar account
signs.

#### `POST /v1/tickets/:ticketId/check-in`

No body.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/check-in" -H "Authorization: Bearer $TOKEN"
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

#### `POST /v1/tickets/:ticketId/confirm-check-in`

| field | type | rules |
|---|---|---|
| `signedXdr` | string | required |
| `txHash` | string | optional, 64 hex characters |
| `gateId` | string | optional, UUID of a gate on this event |
| `reason` | string | optional, up to 512 characters, for manual overrides |

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/confirm-check-in" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"signedXdr":"AAAAAgAA...","gateId":"8c0e2a4b-6d1f-4c3e-9a5b-7d8e9f0a1b2d"}'
```

Returns the ticket row with `status: "USED"`, `checkedInAt`,
`checkedInGateId` and `checkInReason`.

#### `POST /v1/tickets/:ticketId/scanner-check-in`

Same body as `confirm-check-in`, authenticated with a scanner device
token instead of a JWT: either `Authorization: Bearer <token>` or
`x-device-token: <token>`. `401` when the token is unknown, revoked, or
registered for a different event than the ticket's.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/scanner-check-in" \
  -H "x-device-token: scn_4f1c...e2a9" -H 'Content-Type: application/json' \
  -d '{"signedXdr":"AAAAAgAA...","gateId":"8c0e2a4b-6d1f-4c3e-9a5b-7d8e9f0a1b2d"}'
```

Returns the ticket row with `status: "USED"`.

### Revoke

Members of the event's organization.

#### `POST /v1/tickets/:ticketId/revoke`

No body. Returns `{ "unsignedXdr": "AAAAAgAA..." }`.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/revoke" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/tickets/:ticketId/confirm-revoke`

Body is `ConfirmSignedTxDto` (`signedXdr`, optional `txHash`). Returns
the ticket row with `status: "REVOKED"` and writes an audit entry. An
`ACTIVE` resale listing for the ticket is set to `CANCELLED` in the same
transaction, so it leaves `GET /v1/tickets/resale`.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/confirm-revoke" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"signedXdr":"AAAAAgAA..."}'
```

#### `POST /v1/tickets/events/:eventId/revoke-batch`

Builds the unsigned `revoke_batch` envelopes for an on-chain bulk revoke
(fraud response). The request is idempotent: repeating it returns the same
payload.

| field | type | rules |
|---|---|---|
| `ticketIds` | string[] | required, 1–100 ids of at most 100 characters each, all on this event |

```bash
curl -s -X POST "$API/v1/tickets/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/revoke-batch" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ticketIds":["6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c","0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a"]}'
```

Returns one envelope per 35 tickets, in the same order as the chunks:

```json
{ "unsignedXdrs": ["AAAAAgAA...", "AAAAAgAA..."], "chunkSize": 35 }
```

The contract's `MAX_BATCH_SIZE` is 35, so 36–100 tickets produce two or three
envelopes. Each envelope must be signed by the organizer and sent to the
confirm endpoint below.

#### `POST /v1/tickets/events/:eventId/confirm-revoke-batch`

Submits every signed `revoke_batch` envelope and then atomically revokes the
tickets, cancels their `ACTIVE` resale listings, and records the processed
transactions.

| field | type | rules |
|---|---|---|
| `ticketIds` | string[] | same ids, in the same order, as the build request |
| `signedXdrs` | string[] | one signed envelope per built chunk, in chunk order |

```bash
curl -s -X POST "$API/v1/tickets/events/7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c/confirm-revoke-batch" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ticketIds":["6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c","0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a"],"signedXdrs":["AAAAAgAA..."]}'
```

```json
{ "count": 2 }
```

`400` when any id is missing from the event, more than 100 are sent, the
number of signed envelopes does not match the chunk count, or a signed
envelope does not match its expected chunk. `409` when only some envelopes
were already confirmed. No database rows are written until every envelope
has been submitted successfully.

### Resale

A resale listing row:

```json
{
  "id": "1e3c5a7b-9d0f-4b2c-8e4a-6f7a8b9c0d1f",
  "ticketId": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
  "sellerId": "9d3a5c1e-7b2f-4e8a-9c6d-1f2e3a4b5c6d",
  "price": "2750000",
  "status": "ACTIVE",
  "txHash": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "expiresAt": "2026-11-30T00:00:00.000Z",
  "createdAt": "2026-09-27T13:00:00.000Z",
  "updatedAt": "2026-09-27T13:00:00.000Z"
}
```

The asking price may not exceed
`floor(ticketType.price * event.maxResaleMultiplierBps / 10000)`
(`400` otherwise), and a seller may hold at most
`MAX_ACTIVE_RESALE_LISTINGS_PER_USER` active listings (`409`).

#### `POST /v1/tickets/:ticketId/list-resale`

Owner only.

| field | type | rules |
|---|---|---|
| `price` | string | required, digits only, up to 39 digits |
| `expiresAt` | string | optional, ISO-8601 (stored at confirm time) |

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/list-resale" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"price":"2750000"}'
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

#### `POST /v1/tickets/:ticketId/confirm-list-resale`

| field | type | rules |
|---|---|---|
| `price` | string | required, digits only, up to 39 digits |
| `expiresAt` | string | optional, ISO-8601 |
| `signedXdr` | string | required |
| `txHash` | string | optional, 64 hex characters |

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/confirm-list-resale" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"price":"2750000","expiresAt":"2026-11-30T00:00:00.000Z","signedXdr":"AAAAAgAA..."}'
```

Returns the new listing row; the ticket moves to `status: "RESALE"`.
`409` when the ticket already has an active listing.

#### `GET /v1/tickets/resale`

Marketplace of `ACTIVE` listings, newest first, cursor paginated. Only
listings a buyer can still complete are returned: the event must be
`PUBLISHED`, not deleted, and not yet started (the contract rejects
`buy_resale` after its resale cutoff), and the listing must not be past its
own `expiresAt`.

| query | type | rules |
|---|---|---|
| `cursor` | string | optional, the previous response's `nextCursor` |
| `limit` | integer | optional, default 20, 1 to 100 |

```bash
curl -s "$API/v1/tickets/resale?limit=20" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "items": [
    {
      "id": "1e3c5a7b-9d0f-4b2c-8e4a-6f7a8b9c0d1f",
      "price": "2750000",
      "status": "ACTIVE",
      "expiresAt": "2026-11-30T00:00:00.000Z",
      "ticket": {
        "id": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
        "seat": "A-12",
        "event": { "id": "7a1f3c5e-9b2d-4e6f-8a0c-1d2e3f4a5b6c", "name": "Launch Night", "royaltyBps": 500 },
        "ticketType": { "id": "4b8d2f6a-0c1e-4a3b-9d5f-6e7a8b9c0d1e", "name": "General Admission", "price": "2500000" }
      },
      "seller": { "name": "Ada Lovelace" },
      "royaltyFee": "137500",
      "platformFee": "68750",
      "sellerProceeds": "2543750"
    }
  ],
  "nextCursor": "MjAyNi0wOS0yN1QxMzowMDowMC4wMDBafDFlM2M1YTdiLTlkMGYtNGIyYy04ZTRhLTZmN2E4YjljMGQxZg",
  "limit": 20
}
```

The split mirrors the contract's `resale_split`, which `buy_resale` settles
with:

- `royaltyFee = floor(price * royaltyBps / 10000)`;
- `platformFee = floor(price * resaleFeeBps / 10000)`, where `resaleFeeBps` is
  the contract's `platform_fee().resale_bps` (0 when no fee is set; cached for
  a minute);
- `sellerProceeds = price - royaltyFee - platformFee`, what the seller
  actually receives.

If the fee cannot be read from the chain and no earlier value is cached,
`platformFee` and `sellerProceeds` are `null` rather than an overstated
figure. `nextCursor` is `null` on the last page; a malformed cursor is a
`400`.

#### `GET /v1/tickets/resale/:listingId/price-history`

Every asking price the listing has had, oldest first.

```bash
curl -s "$API/v1/tickets/resale/1e3c5a7b-9d0f-4b2c-8e4a-6f7a8b9c0d1f/price-history" -H "Authorization: Bearer $TOKEN"
```

```json
[
  { "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "resaleListingId": "1e3c5a7b-9d0f-4b2c-8e4a-6f7a8b9c0d1f", "price": "2750000", "createdAt": "2026-09-27T13:00:00.000Z" },
  { "id": "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", "resaleListingId": "1e3c5a7b-9d0f-4b2c-8e4a-6f7a8b9c0d1f", "price": "2600000", "createdAt": "2026-09-28T09:00:00.000Z" }
]
```

#### `PATCH /v1/tickets/resale/:listingId/price`

Seller only, listing must be `ACTIVE`. Off-chain: records the new
asking price and a history row.

| field | type | rules |
|---|---|---|
| `price` | string | required, digits only, within the event cap |

```bash
curl -s -X PATCH "$API/v1/tickets/resale/1e3c5a7b-9d0f-4b2c-8e4a-6f7a8b9c0d1f/price" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"price":"2600000"}'
```

Returns the listing row with the new `price`.

#### `POST /v1/tickets/:ticketId/buy-resale`

Any signed-in user with a wallet. `400` (`LISTING_INACTIVE`) unless the
ticket is in `RESALE`.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/buy-resale" -H "Authorization: Bearer $TOKEN"
```

```json
{ "unsignedXdr": "AAAAAgAA..." }
```

#### `POST /v1/tickets/:ticketId/confirm-buy-resale`

Body is `ConfirmSignedTxDto`. Marks the listing `SOLD` and returns the
ticket row with the buyer as `ownerId` and `status: "VALID"`.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/confirm-buy-resale" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"signedXdr":"AAAAAgAA..."}'
```

#### `POST /v1/tickets/:ticketId/cancel-resale`

Owner only. Returns `{ "unsignedXdr": "AAAAAgAA..." }`.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/cancel-resale" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/tickets/:ticketId/confirm-cancel-resale`

Body is `ConfirmSignedTxDto`. Marks the listing `CANCELLED` and the
ticket `VALID`. Responds `201` with an empty body.

```bash
curl -s -X POST "$API/v1/tickets/6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c/confirm-cancel-resale" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"signedXdr":"AAAAAgAA..."}'
```

#### `POST /v1/tickets/resale/cancel-expired`

Sweeps `ACTIVE` listings whose `expiresAt` has passed: listing to
`CANCELLED`, ticket back to `VALID`. The scheduler runs the same job;
see [RESALE_EXPIRY.md](RESALE_EXPIRY.md).

```bash
curl -s -X POST "$API/v1/tickets/resale/cancel-expired" -H "Authorization: Bearer $TOKEN"
```

```json
{ "cancelledCount": 3 }
```

## Refunds

Admin-only endpoints (`PLATFORM_ADMIN`) for tracking off-chain refunds of primary ticket sales. See [`docs/REFUNDS.md`](REFUNDS.md) for full eligibility rules and lifecycle details.

### Refund Rules

- **REVOKED tickets**: Allowed.
- **Cancelled events**: Allowed for unused tickets belonging to an event with status `CANCELLED`.
- **Refund window**: Allowed for `VALID` tickets when the event has not started yet (`now < event.startsAt`).
- **Ineligible**: `USED` tickets, tickets with an existing refund record, or requests after the event start time are rejected.

### `POST /v1/refunds`

Creates a `PENDING` refund record for an eligible ticket.

```bash
curl -s -X POST "$API/v1/refunds" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ticketId":"6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c"}'
```

```json
{
  "id": "e4a2d3c1-0b5e-4f7a-8c9d-1e2f3a4b5c6d",
  "ticketId": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
  "status": "PENDING",
  "createdAt": "2026-11-23T20:00:00.000Z",
  "completedAt": null
}
```

### `PATCH /v1/refunds/:id/complete`

Marks an existing refund as `COMPLETED`.

```bash
curl -s -X PATCH "$API/v1/refunds/e4a2d3c1-0b5e-4f7a-8c9d-1e2f3a4b5c6d/complete" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "e4a2d3c1-0b5e-4f7a-8c9d-1e2f3a4b5c6d",
  "ticketId": "6f0a2c4e-8b1d-4f3a-9e5c-7d8e9f0a1b2c",
  "status": "COMPLETED",
  "createdAt": "2026-11-23T20:00:00.000Z",
  "completedAt": "2026-11-23T20:05:00.000Z"
}
```

## Stellar

### `GET /v1/stellar/circuit-breaker/metrics`

Public. State of the breaker that wraps every Soroban RPC call
(`CLOSED`, `OPEN` or `HALF_OPEN`).

```bash
curl -s "$API/v1/stellar/circuit-breaker/metrics"
```

```json
{ "state": "CLOSED", "consecutiveFailures": 0, "totalSuccesses": 1240, "totalFailures": 2, "rejectedCalls": 0 }
```

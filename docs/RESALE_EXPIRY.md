# Resale Listing Expiry, Limits, and Audit History

## Overview

This document describes the resale marketplace enhancements implemented for resale listings on StellarTickets.

## Features

### 1. Resale Listing Expiration (`expiresAt`)

- Sellers can optionally provide an expiration timestamp (`expiresAt`) when creating a resale listing.
- The `ResaleExpiryService` periodically inspects active resale listings where `expiresAt <= now()`.
- Expired listings have their status transitioned to `CANCELLED`, and the underlying ticket's status is reverted to `VALID`.

### 2. Configurable Soft Limit Cap

- Prevents sellers from flooding the marketplace with excessive listings.
- Configured via the `MAX_ACTIVE_RESALE_LISTINGS_PER_USER` environment variable (default: `5`).
- Listing creation requests exceeding this limit throw an HTTP 409 (`ConflictException`).

### 3. Resale Price History Audit

- Every price set or updated on a resale listing is recorded in the `ResalePriceHistory` audit table.
- Accessible via the `GET /tickets/resale/:listingId/price-history` endpoint.
- Updated via the `PATCH /tickets/resale/:listingId/price` endpoint.

## Limitations

- **Expiry is database-only and does not delist on-chain.** `cancelExpiredListings` sets the listing to `CANCELLED` and the ticket back to `VALID` in Postgres. It submits no Soroban transaction. `list_for_resale` sends only the owner, the ticket id and the price, so `expiresAt` never reaches the `ticketing` contract, and the on-chain listing stays active after the API marks it cancelled.
- **Buying an expired listing is possible until the next expiry run.** The expiry job runs every 60 seconds, and `buy-resale` gates only on the ticket's database status being `RESALE`. Between `expiresAt` and the next run, the API still builds a buy transaction for the listing.
- **Expiry is a timer in each API process.** `ResaleExpiryService` starts on boot and runs every 60 seconds. It is registered in `TicketsModule`, so `SCHEDULER_ENABLED=false` does not turn it off. Every instance runs it. `POST /v1/tickets/resale/cancel-expired` runs the same cancel on demand.
- **The owner must clean up the chain.** Nothing in the API cancels the on-chain listing on the seller's behalf. The owner has to call `cancel-resale` and sign the transaction. The API cannot do this for them.
- **The listing limit counts database rows.** `MAX_ACTIVE_RESALE_LISTINGS_PER_USER` is checked against `ACTIVE` rows, so a listing that is still live on-chain but already `CANCELLED` in the database does not count toward it.

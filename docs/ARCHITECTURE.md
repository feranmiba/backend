# Architecture

## Module layout

- `auth` — registration, login, JWT issuance and validation
- `users` — profile, wallet connect, email lookup for recipient resolution
- `organizations` — organizer accounts and membership
- `events` — event/ticket-type CRUD and on-chain publishing
- `tickets` — the full ticket lifecycle (issue, purchase, transfer,
  check-in, revoke, resale)
- `stellar` — the only module that talks to Soroban RPC

## The non-custodial write path

Every on-chain write follows the same two-step shape:

1. `build*Tx` in `StellarService` simulates the call against the
   caller's own public key and returns an unsigned XDR envelope.
2. The caller's wallet signs it client-side.
3. `submitSignedTransaction` relays the signed envelope and polls it
   to completion.

No other module calls Soroban RPC directly — they all go through
`StellarService`, which keeps the "we never hold a key" invariant in
one place.

## Ticket lifecycle

The diagrams below trace each ticket action through the same
participants:

| Participant | What it is |
|---|---|
| Wallet | The signer's browser wallet (Freighter etc.). Holds the private key; the API never sees it. |
| Client | Dashboard, marketplace or scanner app calling the REST API with a JWT. |
| API | The NestJS controller and service for the route, `TicketsService` unless stated otherwise. |
| Postgres | The Prisma read-model: `Ticket`, `TicketType`, `ResaleListing`, and so on. The contract stays the source of truth. |
| StellarService | Builds envelopes, relays signed ones and runs read-only simulations. |
| Soroban RPC | The network endpoint. Every `build` call ends in `prepareTransaction`, which simulates the call and attaches footprint and fee. |

Conventions shared by every flow:

- `build` endpoints (`POST /v1/tickets/issue`, `POST /v1/tickets/:ticketId/transfer`, ...) return `{ unsignedXdr }`. They accept an optional `Idempotency-Key` header so a retried request replays the same envelope instead of building a new one.
- `confirm-*` endpoints take the wallet-signed envelope back as `signedXdr` and re-run the authorization checks before relaying it, so a stale or replayed envelope cannot bypass a rule that changed in between.
- `submitSignedTransaction` sends the envelope, then polls `getTransaction` once a second for up to fifteen seconds. A rejected submission, an on-chain failure or a timeout surfaces as an error and nothing is written to Postgres.
- Postgres writes happen only after the chain confirms. The `Ticket.status` column mirrors the on-chain `TicketStatus` and is reconciled again on every `verify` call.
- Every identifier the contract uses is a `u64` (`chainEventId`, `chainTicketId`) and every price is an `i128`, so both travel through JSON as strings.

### Issue (organizer hands out a ticket)

An organizer issues a ticket to an attendee when payment settled off-chain
(a comp, a sponsor allocation, a box-office sale). The organizer's
organization account is the transaction source and signs.

```mermaid
sequenceDiagram
    autonumber
    participant Wallet as Organizer wallet
    participant Client
    participant API as API (TicketsService)
    participant Postgres
    participant Stellar as StellarService
    participant RPC as Soroban RPC

    Client->>API: POST /v1/tickets/issue (ticketTypeId, toUserId, toPublicKey, seat)
    API->>Postgres: load ticket type, event, organization, recipient
    API->>API: assert organizer membership, capacity, sale window, event published, recipient wallet matches toPublicKey
    API->>Stellar: buildIssueTicketTx(organizer, chainEventId, to, tier, seat, price)
    Stellar->>RPC: getAccount(organizer)
    Stellar->>RPC: prepareTransaction(issue_ticket call)
    RPC-->>Stellar: simulated envelope with footprint and fee
    Stellar-->>API: unsigned XDR
    API-->>Client: 201 unsignedXdr
    Client->>Wallet: sign envelope
    Wallet-->>Client: signedXdr
    Client->>API: POST /v1/tickets/confirm-issue (same fields + signedXdr)
    API->>Postgres: re-check membership, recipient wallet, seat not taken (409 if it is)
    API->>Stellar: submitSignedTransaction(signedXdr)
    Stellar->>RPC: sendTransaction
    loop up to 15 times, 1s apart
        Stellar->>RPC: getTransaction(hash)
    end
    RPC-->>Stellar: SUCCESS, return value = chainTicketId
    Stellar-->>API: chainTicketId, txHash
    API->>Postgres: BEGIN, lock TicketType FOR UPDATE, re-check capacity, quantityIssued + 1, INSERT Ticket
    Postgres-->>API: Ticket (status VALID, issuedTxHash)
    API-->>Client: 201 Ticket
```

### Purchase (attendee buys at face value)

The buyer is the transaction source, so the buyer's wallet signs and
the payment settles inside the same contract call that creates the
ticket. A promo code, when supplied, is validated at build time to
compute the discounted price and redeemed only after the chain
confirms.

```mermaid
sequenceDiagram
    autonumber
    participant Wallet as Buyer wallet
    participant Client
    participant API as API (TicketsService)
    participant Postgres
    participant Stellar as StellarService
    participant RPC as Soroban RPC

    Client->>API: POST /v1/tickets/purchase (ticketTypeId, seat, promoCode)
    API->>Postgres: load ticket type, event, buyer
    API->>API: assert capacity, event published, buyer wallet connected
    opt promoCode present
        API->>Postgres: validate code (active, not expired, redemptions left, not used by buyer)
        API->>API: price = discountedPrice
    end
    API->>Stellar: buildPurchasePrimaryTx(buyer, chainEventId, tier, seat, price)
    Stellar->>RPC: getAccount(buyer)
    Stellar->>RPC: prepareTransaction(purchase_primary call)
    Stellar-->>API: unsigned XDR
    API-->>Client: 201 unsignedXdr
    Client->>Wallet: sign envelope
    Wallet-->>Client: signedXdr
    Client->>API: POST /v1/tickets/confirm-purchase (ticketTypeId, seat, promoCode, signedXdr)
    API->>Postgres: seat not taken (409 if it is)
    API->>Stellar: submitSignedTransaction(signedXdr)
    Stellar->>RPC: sendTransaction, then poll getTransaction
    RPC-->>Stellar: SUCCESS, return value = chainTicketId
    Stellar-->>API: chainTicketId, txHash
    API->>Postgres: BEGIN, lock TicketType FOR UPDATE, re-check capacity, quantityIssued + 1, INSERT Ticket (owner = buyer)
    opt promoCode present
        API->>Postgres: record redemption for buyer and ticket
    end
    API-->>Client: 201 Ticket
    API--)Client: receipt email to the buyer (best effort)
```

### Transfer (owner gives a ticket to another user)

The current owner is the source. The recipient must already have a
wallet connected, and the `toPublicKey` in the request has to match it,
so a ticket cannot be sent to an address the platform cannot link to an
account.

```mermaid
sequenceDiagram
    autonumber
    participant Wallet as Owner wallet
    participant Client
    participant API as API (TicketsService)
    participant Postgres
    participant Stellar as StellarService
    participant RPC as Soroban RPC

    Client->>API: POST /v1/tickets/:ticketId/transfer (toUserId, toPublicKey)
    API->>Postgres: load ticket, owner, recipient
    API->>API: assert caller owns the ticket and recipient wallet matches toPublicKey
    API->>Stellar: buildTransferTicketTx(owner, chainTicketId, to)
    Stellar->>RPC: getAccount(owner), prepareTransaction(transfer_ticket call)
    Stellar-->>API: unsigned XDR
    API-->>Client: 201 unsignedXdr
    Client->>Wallet: sign envelope
    Wallet-->>Client: signedXdr
    Client->>API: POST /v1/tickets/:ticketId/confirm-transfer (toUserId, toPublicKey, signedXdr)
    API->>Postgres: re-check ownership and recipient wallet
    API->>Stellar: submitSignedTransaction(signedXdr)
    Stellar->>RPC: sendTransaction, then poll getTransaction
    RPC-->>Stellar: SUCCESS
    API->>Postgres: UPDATE Ticket SET ownerId = toUserId, status = VALID
    API-->>Client: 201 Ticket
```

### Resale (list, buy, cancel)

Resale is three actions on the same ticket. Listing and cancelling are
signed by the owner, buying by the buyer. Two rules are enforced
off-chain before the envelope is built and again at confirm time:
the asking price may not exceed `floor(facePrice * maxResaleMultiplierBps / 10000)`
for the event, and a seller may hold at most
`MAX_ACTIVE_RESALE_LISTINGS_PER_USER` active listings (default 5). The
contract enforces the same cap on-chain; the off-chain check only turns
a failed simulation into a clear 400.

```mermaid
sequenceDiagram
    autonumber
    participant SellerWallet as Seller wallet
    participant BuyerWallet as Buyer wallet
    participant Client
    participant API as API (TicketsService)
    participant Postgres
    participant Stellar as StellarService
    participant RPC as Soroban RPC

    rect rgb(235, 245, 255)
        Note over Client,RPC: List for resale (seller signs)
        Client->>API: POST /v1/tickets/:ticketId/list-resale (price)
        API->>Postgres: load ticket with ticket type and event, count seller's ACTIVE listings
        API->>API: assert ownership, price within the event cap, listing limit not reached
        API->>Stellar: buildListForResaleTx(owner, chainTicketId, price)
        Stellar->>RPC: getAccount(owner), prepareTransaction(list_for_resale call)
        API-->>Client: 201 unsignedXdr
        Client->>SellerWallet: sign
        SellerWallet-->>Client: signedXdr
        Client->>API: POST /v1/tickets/:ticketId/confirm-list-resale (price, expiresAt, signedXdr)
        API->>Postgres: no ACTIVE listing for this ticket yet (409 if there is), re-check cap and limit
        API->>Stellar: submitSignedTransaction(signedXdr)
        Stellar->>RPC: sendTransaction, then poll getTransaction
        API->>Postgres: BEGIN, Ticket.status = RESALE, INSERT ResaleListing (ACTIVE, price, txHash, expiresAt) + first ResalePriceHistory row
        API-->>Client: 201 ResaleListing
    end

    rect rgb(240, 255, 240)
        Note over Client,RPC: Buy from the marketplace (buyer signs)
        Client->>API: GET /v1/tickets/resale
        API-->>Client: ACTIVE listings with royaltyFee, platformFee and sellerProceeds precomputed
        Client->>API: POST /v1/tickets/:ticketId/buy-resale
        API->>Postgres: ticket status must be RESALE
        API->>Stellar: buildBuyResaleTx(buyer, chainTicketId)
        Stellar->>RPC: getAccount(buyer), prepareTransaction(buy_resale call)
        API-->>Client: 201 unsignedXdr
        Client->>BuyerWallet: sign
        BuyerWallet-->>Client: signedXdr
        Client->>API: POST /v1/tickets/:ticketId/confirm-buy-resale (signedXdr)
        API->>Stellar: submitSignedTransaction(signedXdr)
        Note over Stellar,RPC: the contract pays the seller and the organizer royalty in the same transaction
        API->>Postgres: BEGIN, ResaleListing.status = SOLD, Ticket.ownerId = buyer, Ticket.status = VALID
        API-->>Client: 201 Ticket
    end

    rect rgb(255, 245, 235)
        Note over Client,RPC: Cancel a listing (seller signs)
        Client->>API: POST /v1/tickets/:ticketId/cancel-resale
        API->>Stellar: buildCancelResaleTx(owner, chainTicketId)
        API-->>Client: 201 unsignedXdr
        Client->>SellerWallet: sign
        Client->>API: POST /v1/tickets/:ticketId/confirm-cancel-resale (signedXdr)
        API->>Stellar: submitSignedTransaction(signedXdr)
        API->>Postgres: BEGIN, Ticket.status = VALID, ResaleListing.status = CANCELLED
        API-->>Client: 201
    end
```

Two off-chain paths touch a listing without a wallet signature because
they change nothing on-chain: `PATCH /v1/tickets/resale/:listingId/price`
records a new asking price (validated against the same cap and appended
to `ResalePriceHistory`), and `POST /v1/tickets/resale/cancel-expired`,
also run on a schedule, flips listings past their `expiresAt` back to
`CANCELLED` and their tickets back to `VALID`. See
[RESALE_EXPIRY.md](RESALE_EXPIRY.md).

### Check-in (gate marks a ticket used)

Two callers can check a ticket in: a staff member with a JWT, and a
registered scanner device with its own bearer token. Both end in the
same `check_in` contract call, signed by the organizer's organization
account, and the same Postgres update. Before scanning, the gate app
usually verifies the QR code, which is a read-only simulation.

```mermaid
sequenceDiagram
    autonumber
    participant Wallet as Organizer wallet
    participant Scanner as Gate app
    participant API as API (TicketsService)
    participant Postgres
    participant Stellar as StellarService
    participant RPC as Soroban RPC

    Scanner->>API: GET /v1/tickets/verify/:qrSecret (staff JWT, rate limited)
    API->>Postgres: load ticket by qrSecret with event, owner, ticket type
    API->>Stellar: verifyTicket(chainTicketId)
    Stellar->>RPC: simulateTransaction(verify_ticket) from the platform signer
    alt RPC reachable
        RPC-->>Stellar: Ticket struct
        API->>Postgres: reconcile Ticket.status if the chain disagrees
        API-->>Scanner: 200 status, owner, onChainOwner, stale = false
    else RPC unreachable
        API-->>Scanner: 200 cached status, stale = true
    end

    Scanner->>API: POST /v1/tickets/:ticketId/check-in (staff JWT)
    API->>Postgres: load ticket with event and organization
    API->>API: assert staff membership in the organization
    API->>Stellar: buildCheckInTx(organizer, chainTicketId)
    Stellar->>RPC: getAccount(organizer), prepareTransaction(check_in call)
    API-->>Scanner: 201 unsignedXdr
    Scanner->>Wallet: sign envelope
    Wallet-->>Scanner: signedXdr
    alt staff JWT
        Scanner->>API: POST /v1/tickets/:ticketId/confirm-check-in (signedXdr, gateId, reason)
        API->>API: assert staff membership
    else scanner device token
        Scanner->>API: POST /v1/tickets/:ticketId/scanner-check-in (signedXdr, gateId)
        API->>Postgres: device token hash is live and belongs to this ticket's event
    end
    opt gateId present
        API->>Postgres: gate belongs to the ticket's event
    end
    API->>Stellar: submitSignedTransaction(signedXdr)
    Stellar->>RPC: sendTransaction, then poll getTransaction
    RPC-->>Stellar: SUCCESS
    API->>Postgres: UPDATE Ticket SET status = USED, checkedInAt, checkedInGateId, checkInReason
    API-->>Scanner: 201 Ticket
```

When the gate has no connectivity at all, the scanner verifies an
Ed25519-signed offline token instead of calling `verify`; see
[OFFLINE_VERIFICATION.md](OFFLINE_VERIFICATION.md).

### Revoke (organizer voids a ticket)

Revocation follows the check-in shape with `revoke_ticket` and ends in
`status = REVOKED`. Batch revocation is also non-custodial: the build step
splits 1–100 ticket ids into chunks of 35 (the contract's `MAX_BATCH_SIZE`)
and returns one unsigned `revoke_batch` envelope per chunk. The confirm step
validates every signed envelope against its expected chunk, submits all of
them, and only then writes `status = REVOKED` to the read model. Both single
and batch confirmation set an `ACTIVE` resale listing to `CANCELLED` in the
same Prisma transaction, so a revoked ticket cannot stay listed for resale.

### Ticket status transitions

`Ticket.status` is a cached projection of the on-chain enum. These are
the transitions the flows above produce:

```mermaid
stateDiagram-v2
    [*] --> VALID: confirm-issue / confirm-purchase
    VALID --> RESALE: confirm-list-resale
    RESALE --> VALID: confirm-cancel-resale, cancel-expired, confirm-buy-resale (new owner)
    VALID --> VALID: confirm-transfer (new owner)
    VALID --> USED: confirm-check-in / scanner-check-in
    VALID --> REVOKED: confirm-revoke / confirm-revoke-batch
    RESALE --> REVOKED: confirm-revoke / confirm-revoke-batch
```

`GET /v1/tickets/verify/:qrSecret` overwrites the cached status with
whatever the contract reports, so a transition made outside this API
(another client calling the contract directly) becomes visible on the
next scan.

# Refund Rules and Workflow

StellarTickets manages primary-sale refunds as off-chain records tracked in PostgreSQL. Since the underlying Soroban contract does not have a native refund vault, refunds track administrative payouts for tickets.

## Eligibility Rules

A refund request (`POST /refunds`) for a ticket is evaluated against the following rules:

1. **REVOKED Tickets**:
   - Tickets that have been administratively or organizer-revoked (`ticket.status === 'REVOKED'`) are always eligible for refunds.

2. **Cancelled Events**:
   - If an event is cancelled (`event.status === 'CANCELLED'`), all unused tickets for that event are eligible for refunds, ensuring ticket holders receive compensation when an event does not take place.

3. **Refund Window (Contract Primary Sale Window)**:
   - Primary tickets with `ticket.status === 'VALID'` are eligible for refund as long as the event has not started yet (`now < event.startsAt`).
   - Once the event start time has arrived (`now >= event.startsAt`), the refund window is closed, and unrevoked tickets for active events can no longer be refunded.

4. **Ineligible Tickets**:
   - **Used Tickets**: Tickets with `status === 'USED'` (checked in or consumed) cannot be refunded under any circumstances.
   - **Duplicate Requests**: A ticket that already has a refund record cannot have a second refund initiated.
   - **Post-Start Non-Revoked Tickets**: Valid tickets after the event start time are rejected with `Refund window has closed for this event`.

## Refund Lifecycle

1. **Creation**:
   - An administrator initiates a refund using `POST /refunds` with `{ "ticketId": "<uuid>" }`.
   - A `Refund` record is created with `status: "PENDING"`.

2. **Completion**:
   - Once funds are transferred back to the ticket buyer, the administrator marks the refund finished using `PATCH /refunds/:id/complete`.
   - The status transitions to `"COMPLETED"` and `completedAt` timestamp is recorded.

## Access Control

- All refund management endpoints are restricted to users with the `PLATFORM_ADMIN` role.

# Feature flags

Experimental features are controlled by environment variables and read through
the typed `FeatureFlagsService`.

| Typed flag | Environment variable | Default  |
| ---------- | -------------------- | -------- |
| `feeBump`  | `FEATURE_FEE_BUMP`   | disabled |
| `indexer`  | `FEATURE_INDEXER`    | disabled |

Only the case-insensitive value `true` enables a flag. Missing values and
all other values are disabled. Inject `FeatureFlagsService` and call
`isEnabled('feeBump')` or `isEnabled('indexer')`; invalid names are rejected
by TypeScript.

## `feeBump` (fee-bump sponsorship)

When `FEATURE_FEE_BUMP=true`, the attendee confirm paths (purchase, transfer,
list for resale, cancel resale, buy resale) wrap the wallet-signed envelope
in a fee bump paid by the platform account (`PLATFORM_SIGNER_SECRET`). The
platform account must hold enough XLM to cover sponsored fees.

The fee bump's declared fee is the spending cap per transaction, set by
`FEE_BUMP_MAX_FEE_STROOPS` (default `100000`, 0.01 XLM). A signed envelope
whose own fee already exceeds the cap is rejected before submission.

## `indexer` (chain event ingestion)

When `FEATURE_INDEXER=true`, a scheduled job (every
`INDEXER_POLL_INTERVAL_SECONDS`, default 30, when the scheduler is on) polls
the ticketing contract's events with `getEvents` and applies `TicketCheckedIn`
to the cached ticket status. The status cached is the ticket's on-chain status
after the check-in, so a multi-use pass with entries left stays `VALID`. See
[`docs/SCHEDULER.md`](SCHEDULER.md) for scheduling and metrics. The position is stored in
`IndexerCursor`, and each applied event is recorded in `ProcessedChainEvent`,
so re-delivered events are skipped. A first run starts from the latest ledger,
so events emitted before the indexer was enabled are not backfilled.

Assumed event payload: the topic names the event, and the value is either a
bare `u64` ticket id or a map with a `ticket_id` field. Verify this against the
contract before enabling the flag in production.

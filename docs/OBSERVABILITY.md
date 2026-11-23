# Observability

## Structured Logging (`nestjs-pino`)

The application uses `nestjs-pino` with `pino-http` for low-overhead, JSON-structured logging in production and development.

### Request ID Correlation (`X-Request-Id`)
Every incoming HTTP request is assigned a unique `X-Request-Id` (or preserves an incoming client-provided `X-Request-Id` header).
- **Responses:** The `X-Request-Id` header is attached to all HTTP responses (success and error).
- **Error Bodies:** All error response payloads (e.g. 400, 404, 500) include `requestId` in the JSON body.
- **Log Correlation:** Every log entry emitted during the request lifecycle carries the `req.id` matching `X-Request-Id`.

### Secret Redaction
Sensitive fields and headers are automatically redacted by Pino's built-in serializer before writing to stdout:
- `req.headers.authorization` (JWT and Bearer tokens)
- `req.headers.cookie`
- `req.headers["x-api-key"]`

### Configurable Log Level (`LOG_LEVEL`)
Logging verbosity is controlled via the `LOG_LEVEL` environment variable.
Valid levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.
- **Production default:** `info`
- **Development default:** `debug`
- **Test default:** `silent`

```bash
# Example in .env
LOG_LEVEL=info
```

## Prioritized Next Steps
1. Error tracking (e.g. Sentry) on unhandled exceptions
2. A dashboard for `StellarService` call latency/failure rate, since that's the module most exposed to external (Soroban RPC) failure

## Prometheus Metrics

When `METRICS_TOKEN` is configured, `GET /metrics` exposes Prometheus text
format metrics. Supply it as a bearer token:

```http
Authorization: Bearer <METRICS_TOKEN>
```

The endpoint reports `http_requests_total` and the
`http_request_duration_seconds` histogram. Labels include the HTTP method,
status code, and the registered route template (for example
`/events/:param`); request path values and query strings are never used as
labels. Requests to `/metrics` are included in the metrics after that scrape
completes. If `METRICS_TOKEN` is unset, the endpoint returns 404.

Generate a random token of at least 32 characters and keep it in the same
secret-management system as other credentials. See
[`docs/CONFIGURATION.md`](CONFIGURATION.md).

### Chain indexer metrics

When the chain event indexer runs (`FEATURE_INDEXER=true`; see
[`docs/SCHEDULER.md`](SCHEDULER.md#chain-event-indexer)), `/metrics` also
reports:

| Metric | Type | Meaning |
|---|---|---|
| `indexer_runs_total{result="success"\|"failure"}` | counter | Polls, by outcome. |
| `indexer_events_applied_total` | counter | Events that changed database state. Re-delivered events are not counted. |
| `indexer_lag_ledgers` | gauge | Ledgers between the last indexed event and the RPC's latest ledger. 0 means the stream is drained. |
| `indexer_last_success_timestamp_seconds` | gauge | Unix time of the last successful poll. |

The two gauges appear only after the first successful poll, so a lag of 0
never means "has not run". Suggested alerts:

- `indexer_lag_ledgers > 120` for 10 minutes: the indexer is falling behind,
  at about 5 s a ledger that is 10 minutes of events.
- `time() - indexer_last_success_timestamp_seconds > 300`: no successful poll
  in 5 minutes.
- A rising `indexer_runs_total{result="failure"}`: RPC or database errors.
  Check the `Chain event indexing failed` log lines.

The counters are per process and reset on restart.

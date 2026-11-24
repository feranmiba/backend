# Configuration

All environment variables are validated at boot by
`src/config/env.validation.ts` — the app refuses to start rather than
run with a missing or malformed value. See
[`.env.example`](../.env.example) for the full list and
[`docs/AUTHENTICATION.md`](AUTHENTICATION.md) /
[`docs/NON_CUSTODIAL.md`](NON_CUSTODIAL.md) for what `JWT_SECRET` and
`PLATFORM_SIGNER_SECRET` are actually used for.

## Checks beyond per-variable format

Besides each variable's own format, `validate()` refuses to start when:

- **`JWT_SECRET` is weak.** Every environment requires at least 32
  characters. With `NODE_ENV=production` the secret must also contain at
  least 10 distinct characters and must not look like a placeholder: after
  lower-casing and removing punctuation, it may not contain `changeme`,
  `replaceme`, `yoursecret`, `jwtsecret`, `secretkey`, `mysecret`,
  `placeholder`, `example`, `default`, `insecure`, `donotuse` or `password`.
  Generate one with `openssl rand -base64 48`. The same rules apply to a
  secret loaded through a [secret provider](#secret-providers).
- **`SOROBAN_RPC_URL` and `STELLAR_NETWORK` disagree.** The network
  passphrase that transactions are signed with comes from `STELLAR_NETWORK`.
  The app can't reach the RPC at boot, so it infers the RPC's network from
  its URL instead: a host or path segment named `testnet`, `futurenet`,
  `mainnet` or `pubnet` (for example `soroban-testnet.stellar.org` or
  `rpc-futurenet.stellar.org`). If that network differs from
  `STELLAR_NETWORK`, startup fails. URLs that name no network, or more than
  one, pass this check; that covers self-hosted or local nodes such as
  `http://localhost:8000/soroban/rpc`. `SOROBAN_RPC_URL` must be an `http`
  or `https` URL.
- **Settlement-asset display settings are invalid.** `SETTLEMENT_ASSET_CODE`
  must be 1–12 uppercase letters or digits, and
  `SETTLEMENT_ASSET_DECIMALS` must be between 0 and 18. These settings describe
  the token already configured as the ticketing contract's `PaymentToken`;
  changing them does not change the on-chain token.
- **`METRICS_TOKEN` is too short.** When set, it must contain at least 32
  characters. It protects the optional `/metrics` endpoint with bearer-token
  authentication.

## API path prefix

Set `API_PREFIX` (for example `api` or `api/v1`) to serve every route under
that path when the API is hosted behind a reverse proxy at a sub-path. With
`API_PREFIX=api/v1`, `POST /auth/login` becomes `POST /api/v1/auth/login`.
`GET /health` stays at the root so load-balancer and orchestrator probes
don't have to change. Leave it unset or empty to keep the current root
paths. Leading and trailing slashes are ignored. Only URL-safe path segments
are accepted, and `.` or `..` segments are rejected.

## Secret providers

`JWT_SECRET` is read through a pluggable `SecretProvider`
(`src/config/secrets/secret-provider.ts`), chosen with `SECRETS_PROVIDER`:

| `SECRETS_PROVIDER` | Reads `JWT_SECRET` from | Required variables |
|---|---|---|
| `env` (default) | the `JWT_SECRET` environment variable | `JWT_SECRET` |
| `file` | the file at `JWT_SECRET_FILE`, with surrounding whitespace trimmed | `JWT_SECRET_FILE` |
| `custom` | the provider passed to `SecretsModule.forRoot({ provider })` | — |

`file` works with Docker and Kubernetes secrets, and with secrets-manager
sidecars that mount values as files, such as Vault Agent or the AWS and GCP
Secrets Store CSI drivers. With `file`, the secret never has to be in the
process environment.

To read the secret straight from a secrets manager instead, implement the
interface and register the class in `src/app.module.ts`:

```ts
@Injectable()
export class VaultSecretProvider implements SecretProvider {
  readonly name = 'vault';

  constructor(private readonly config: ConfigService) {}

  async getSecret(key: string): Promise<string | undefined> {
    // Fetch `key` from your secrets manager here.
  }
}

// app.module.ts
SecretsModule.forRoot({ provider: VaultSecretProvider }),
```

Then start the app with `SECRETS_PROVIDER=custom`. The secret is resolved
once at boot (`src/auth/jwt-secret.module.ts`) and is used both to sign
tokens (`JwtModule`) and to verify them (`JwtStrategy`). If the secret is
missing, or fails the strength rules above, the app doesn't start. Rotating
the secret requires a restart, and a restart invalidates tokens already
issued.

## Email Notification Provider

Email notifications (email verification, purchase receipts, and event reminders)
are delivered through the configured `EMAIL_PROVIDER`:

| `EMAIL_PROVIDER` | Description | Required configuration |
|---|---|---|
| `log` | Logs email payload and recipient to console (development/test default) | None |
| `smtp` | Delivers emails via standard SMTP / AWS SES SMTP interface | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` |

In `production` (`NODE_ENV=production`), `EMAIL_PROVIDER` defaults to `smtp` and
requires valid SMTP configuration. Silent fallback to `LogEmailProvider` is
strictly rejected at startup.

Supported SMTP variables:
- `SMTP_HOST`: Hostname of SMTP server (e.g. `smtp.sendgrid.net` or `email-smtp.us-east-1.amazonaws.com`)
- `SMTP_PORT`: Port (e.g. `587` for STARTTLS, `465` for direct TLS, or `25`)
- `SMTP_USER`: Authentication username (optional if relay is unauthenticated)
- `SMTP_PASSWORD`: Authentication password (required when `SMTP_USER` is set)
- `SMTP_FROM`: Sender address (e.g. `"StellarTickets <tickets@example.com>"`)
- `SMTP_SECURE`: `true` for direct TLS (port 465), `false` for STARTTLS (port 587)

## Environment variables

<!-- BEGIN GENERATED: env table (npm run docs:env) -->

| Variable | Type | Required | Default | Validated at boot | Description |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | `development \| test \| production` | **required** | `development` | yes | Which NestJS environment the app runs in. Drives logging verbosity and whether development-only behaviour is enabled.
| `LOG_LEVEL` | `fatal \| error \| warn \| info \| debug \| trace \| silent` | optional | `debug` | yes | Log level for pino logger: fatal, error, warn, info, debug, trace, silent.
| `OTEL_TRACING_ENABLED` | `true \| false` | optional | `false` | yes | Opt in to HTTP/NestJS OpenTelemetry spans. Off unless literally 'true'. See docs/TRACING.md.
| `OTEL_SERVICE_NAME` | string | optional | `stellar-tickets-backend` \* | yes | Service name attached to exported spans; defaults to stellar-tickets-backend.
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | string | optional | `http://localhost:4318/v1/traces` \* | yes | OTLP HTTP trace collector URL. Defaults to http://localhost:4318/v1/traces.
| `PORT` | integer | **required** | `3000` | yes | TCP port the HTTP server binds. Match it to the `port` in docker-compose.yml when running the API in a container.
| `API_PREFIX` | — | optional | — | yes | Optional path every route is mounted under (e.g. `api/v1`), for hosting behind a reverse-proxy path. Health routes stay at the root.
| `MAX_ACTIVE_RESALE_LISTINGS_PER_USER` | integer | optional | `5` | yes | Soft cap on how many `ACTIVE` resale listings one seller may hold at once. Listing beyond it is rejected, not queued. See docs/RESALE_EXPIRY.md.
| `DATABASE_URL` | string | **required** | — | yes | PostgreSQL connection string for the Prisma client. This is the single system of record; see docs/DATABASE.md.
| `RATE_LIMIT_STORE` | `memory \| redis` | optional | `memory` | yes | Where rate-limit counters live. `memory` (default) is per-process; `redis` shares them across instances. See docs/RATE_LIMITING.md.
| `CACHE_DRIVER` | `memory \| redis` | optional | `memory` | yes | Where cached entries live. `memory` (default) is per-process; `redis` shares them across instances. See docs/CACHING.md.
| `CACHE_TTL_SECONDS` | integer | optional | `60` \* | yes | Default time-to-live, in seconds, for entries written by the response cache interceptor on public event listings. Default 60. See docs/CACHING.md.
| `WEBHOOK_QUEUE_ENABLED` | `true \| false` | optional | `false` | yes | Enables the BullMQ-backed outbound webhook queue. Kept as the literal strings 'true'/'false' (like the feature flags) because implicit conversion would turn the string 'false' into boolean true. Off unless 'true'. See docs/WEBHOOKS.md.
| `WEBHOOK_QUEUE_ATTEMPTS` | integer | optional | `5` \* | yes | Total delivery attempts per webhook, the first included. Default 5.
| `WEBHOOK_QUEUE_BACKOFF_MS` | integer | optional | `5000` \* | yes | Delay before the first webhook retry, doubling on each further retry. Default 5000.
| `SCHEDULER_ENABLED` | `true \| false` | optional | `true` | yes | Set to 'false' to switch off every cron job registered through SchedulerModule. On unless 'false'. See docs/SCHEDULER.md.
| `REDIS_URL` | string | conditional | — | yes (when required) | Redis connection URL (e.g. redis://localhost:6379). Required when RATE_LIMIT_STORE=redis, CACHE_DRIVER=redis or WEBHOOK_QUEUE_ENABLED=true.
| `SECRETS_PROVIDER` | — | optional | `env` | yes | Where secrets such as JWT_SECRET are read from: `env` (default), `file` (`<KEY>_FILE` paths) or `custom` (a provider passed to `SecretsModule.forRoot`). See docs/CONFIGURATION.md.
| `JWT_SECRET` | string | conditional | — | yes (when required) | Required when SECRETS_PROVIDER is `env` (the default).
| `JWT_SECRET_FILE` | string | conditional | — | yes (when required) | Path of the file holding JWT_SECRET; required when SECRETS_PROVIDER=file.
| `CORS_ORIGINS` | string | **required** | `http://localhost:3001` | yes | Comma-separated list of allowed CORS origins (e.g. "https://app.example.com,https://staging.example.com"). Wildcard (*) is NOT allowed in production. Used as the CORS allow-list and to build links in outbound email/webhooks.
| `JSON_BODY_LIMIT` | string | optional | `100kb` | yes | Maximum accepted JSON request body, as an Express size string such as 100kb or 1mb. Larger payloads are rejected with 413. Default 100kb.
| `CSP_DIRECTIVES` | string | optional | — | yes | Helmet Content-Security-Policy directives as a JSON object string, e.g. {"defaultSrc":["'self'"]}. Leave unset to keep helmet's defaults.
| `TRUST_PROXY` | string | optional | — | yes | Express `trust proxy` setting: `true`, `false`, a hop count, or a comma-separated list of proxy IPs / CIDR ranges. Unset means `false`. See docs/DEPLOYMENT.md.
| `SOROBAN_RPC_URL` | string | **required** | — | yes | Soroban RPC endpoint the StellarService submits contract calls through.
| `SETTLEMENT_ASSET_CODE` | string | optional | `XLM` | yes | Code shown alongside ticket prices for the configured contract settlement token.
| `SETTLEMENT_ASSET_DECIMALS` | integer | optional | `7` | yes | Number of decimal places in the smallest unit used for ticket prices.
| `METRICS_TOKEN` | string (min 32 chars) | optional | — | yes | Bearer token protecting the Prometheus metrics endpoint; unset disables it.
| `STELLAR_NETWORK` | — | **required** | `testnet` | yes | Which Stellar network every contract call targets. Must match the network the `ticketing` contract is deployed on and the one user wallets are set
| `TICKETING_CONTRACT_ID` | — | **required** | — | yes | Deployed `ticketing` contract's C... address.
| `SOROBAN_RPC_TIMEOUT_MS` | integer | optional | `10000` \* | yes | Timeout, in milliseconds, for a single Soroban RPC call before it's treated as failed. Default 10000 (10s). See issue #145.
| `PLATFORM_SIGNER_SECRET` | — | **required** | — | yes | Platform hot wallet used only as a disposable source account for read-only contract simulations (verify_ticket, get_event). It signs nothing and is never used for a write. See docs/NON_CUSTODIAL.md.
| `OFFLINE_SIGNING_KEY_ID` | string | **required** | `2026-01` | yes | Key id of the Ed25519 key currently used to sign offline verification tokens. Must have a matching entry in OFFLINE_SIGNING_PUBLIC_KEYS.
| `OFFLINE_SIGNING_PRIVATE_KEY` | string | **required** | — | yes | PEM-encoded Ed25519 private key used to sign offline verification tokens. See docs/OFFLINE_VERIFICATION.md for generation and rotation.
| `OFFLINE_SIGNING_PUBLIC_KEYS` | string | **required** | — | yes | JSON map of key id -> PEM-encoded Ed25519 public key. Every key a scanner should still accept, current and retired, so tokens signed before a rotation keep verifying until they expire.
| `TRANSACTION_BUILD_TIMEOUT_SECONDS` | integer | optional | `300` \* | yes | Soroban transaction time-bound set on every `build*Tx` envelope, in seconds. Default 300. See docs/NON_CUSTODIAL.md.
| `TRANSACTION_POLL_TIMEOUT_SECONDS` | integer | optional | `15` \* | yes | How long `submitSignedTransaction` polls `getTransaction` for a result before giving up, in seconds. Default 15.
| `PENDING_TX_RETENTION_MINUTES` | integer | optional | `60` | yes | How long a PendingTx row (build-transaction intent) stays valid before it's considered expired and eligible for cleanup.
| `PENDING_TX_CLEANUP_INTERVAL_MINUTES` | integer | optional | `15` | yes | How often the PendingTx cleanup job runs, in minutes.
| `TICKET_RECONCILIATION_INTERVAL_MINUTES` | integer | optional | `60` \* | yes | How often to compare cached ticket statuses with `verify_ticket`, in minutes. Defaults to 60.
| `IDEMPOTENCY_KEY_TTL_MINUTES` | integer | optional | `15` | yes | How long a cached response for an Idempotency-Key stays valid, in minutes, before a repeated key is treated as a new request.
| `FEE_BUMP_MAX_FEE_STROOPS` | integer | optional | `100000` \* | yes | Ceiling, in stroops, on the platform-paid fee for one sponsored attendee transaction when FEATURE_FEE_BUMP is on. Default 100000 (0.01 XLM).
| `EMAIL_PROVIDER` | `log \| smtp` | optional | `log` | yes | Outbound email notification provider: `log` (console logging) or `smtp` (real delivery). Defaults to `log` in development/test and `smtp` in production.
| `SMTP_HOST` | string | optional | `smtp.example.com` \* | yes | SMTP server hostname or IP address. Required when EMAIL_PROVIDER=smtp or in production.
| `SMTP_PORT` | integer | optional | `587` \* | yes | SMTP port (e.g. 587 for STARTTLS, 465 for TLS, or 25). Required when EMAIL_PROVIDER=smtp or in production.
| `SMTP_USER` | string | optional | — | yes | Username for SMTP authentication. Optional if the SMTP server does not require authentication.
| `SMTP_PASSWORD` | string | optional | — | yes | Password for SMTP authentication. Required when SMTP_USER is set.
| `SMTP_FROM` | string | optional | `tickets@example.com` \* | yes | Default sender address for outbound emails (e.g. "StellarTickets <tickets@example.com>"). Required when EMAIL_PROVIDER=smtp or in production.
| `SMTP_SECURE` | `true \| false` | optional | `false` \* | yes | Whether to enforce direct TLS for SMTP (true for port 465, false for 587/STARTTLS). Default false.
| `SCAN_RATE_LIMIT_MAX` | integer | optional | `10` | **no** | Scans allowed per window per device, for ticket check-in abuse prevention. See docs/RATE_LIMITING.md.
| `SCAN_RATE_LIMIT_WINDOW_MS` | integer | optional | `60000` | **no** | Length of the scan rate-limit window, in milliseconds.
| `FEATURE_FEE_BUMP` | boolean (string) | optional | `false` | **no** | Experimental: enable the fee-bump path. Off unless exactly 'true'. See docs/FEATURE_FLAGS.md.
| `FEATURE_INDEXER` | boolean (string) | optional | `false` | **no** | Experimental: enable the chain indexer. Off unless exactly 'true'. See docs/FEATURE_FLAGS.md.
| `INDEXER_POLL_INTERVAL_SECONDS` | integer | optional | `30` \* | yes | #530 — how often the chain event indexer polls `getEvents`, in seconds. Only used when `FEATURE_INDEXER=true`. Defaults to 30.
| `ISSUE_BATCH_MAX_SIZE` | integer | optional | `50` | **no** | Maximum number of recipients in a single POST /tickets/issue-batch request.
| `QR_TOKEN_TTL_SECONDS` | integer | optional | `30` | **no** | How long a rotating QR token from GET /tickets/:ticketId/qr-token stays valid, in seconds.
| `QR_TOKEN_CLOCK_SKEW_SECONDS` | integer | optional | `5` | **no** | Extra grace, in seconds, after a rotating QR token expires, for scanners whose clock runs behind.
| \* | | | | | The value used in code when the variable is unset. Commented out in `.env.example` because it only applies once the related optional feature is enabled. |

<!-- END GENERATED: env table -->

The table above is generated from `src/config/env.validation.ts` and
`.env.example` by `npm run docs:env`. Do not edit it by hand — edit one of
those two files and re-run the script. `npm run docs:check` fails if the two
sources have drifted apart, so a variable added to one but not the other
cannot land unnoticed.

**Validated at boot** means the app refuses to start when the value is missing
or malformed. A handful of variables are read directly by `ConfigService`
without going through validation — they are flagged **no** above. A typo in
one of those fails *silently* and the feature simply stays on its default, so
check the spelling if a flag or limit does not take effect.

## Security Headers (Helmet)

The API uses [helmet](https://helmetjs.github.io/) with these defaults:
- `contentSecurityPolicy`: enabled (configurable via `CSP_DIRECTIVES`)
- `crossOriginEmbedderPolicy`: enabled
- `crossOriginOpenerPolicy`: enabled
- `crossOriginResourcePolicy`: enabled
- `dnsPrefetchControl`: enabled
- `frameguard`: enabled (deny)
- `hidePoweredBy`: enabled
- `hsts`: enabled (1 year, includeSubDomains)
- `ieNoOpen`: enabled
- `noSniff`: enabled
- `originAgentCluster`: enabled
- `referrerPolicy`: enabled (no-when-downgrade)
- `xssFilter`: enabled

Disabled headers (not needed for API-only backend):
- `x-powered-by`: removed by `hidePoweredBy`
- `x-dns-prefetch-control`: controlled by `dnsPrefetchControl`

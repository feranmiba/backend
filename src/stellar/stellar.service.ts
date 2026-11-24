import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  Contract,
  FeeBumpTransaction,
  Keypair,
  scValToNative,
  Transaction,
  TransactionBuilder,
  rpc,
  BASE_FEE,
  xdr,
} from '@stellar/stellar-sdk';
import {
  contractArgs,
  encodeBuyResale,
  encodeCancelResale,
  encodeCheckIn,
  encodeCreateEvent,
  encodeIssueTicket,
  encodeListForResale,
  encodePurchasePrimary,
  encodeRevokeBatch,
  encodeRevokeTicket,
  encodeTransferTicket,
  type EventParams,
} from './ticketing-bindings';
import { CircuitBreaker } from './circuit-breaker';
import {
  NETWORK_PASSPHRASES,
  StellarNetwork,
} from '../config/stellar-networks';
import { mapSorobanErrorToApiException } from './soroban-errors';
import { REVOKE_BATCH_CHUNK_SIZE } from '../common/constants/revoke-batch.constant';

export { REVOKE_BATCH_CHUNK_SIZE };

export interface OnChainTicket {
  eventId: bigint;
  owner: string;
  tier: string;
  seat: string;
  status: 'Valid' | 'Used' | 'Revoked' | 'Resale';
  originalPrice: bigint;
  resalePrice: bigint;
}

export interface OnChainEvent {
  eventId: bigint;
  organizer: string;
  name: string;
  category: string;
  maxResaleMultiplierBps: number;
  royaltyBps: number;
  ticketsIssued: bigint;
}

/** A ticketing-contract event the chain indexer applies (#163). */
export interface ChainTicketEvent {
  /** RPC event id; unique per emitted event, so it dedupes re-delivery. */
  id: string;
  pagingToken: string;
  ledger: number;
  /** Event topic, e.g. `TicketIssued` or `TicketCheckedIn`. */
  name: string;
  /** Ticket the event refers to, or null when the payload carries none. */
  chainTicketId: bigint | null;
}

/** One `getEvents` page, with the RPC's latest ledger for lag tracking (#530). */
export interface ChainTicketEventPage {
  events: ChainTicketEvent[];
  latestLedger: number;
}

/** The single ticketing-contract call carried by a signed envelope. */
export interface SignedInvocation {
  functionName: string;
  /** Arguments decoded to native values (bigint, string, number). */
  args: unknown[];
}

/**
 * Wrapper around the `ticketing` Soroban contract. This service never holds
 * a user's Stellar secret key — the platform is non-custodial by design.
 * Every write is a two-step "build then submit" flow:
 *
 *   1. `build*Tx(...)` simulates the call against the user's own public key
 *      as the source account and returns an unsigned, fee-prepared XDR
 *      envelope for the caller's wallet (Freighter, etc.) to sign.
 *   2. `submitSignedTransaction(signedXdr)` relays the wallet-signed
 *      envelope to the network and polls it through to completion.
 *
 * `PLATFORM_SIGNER` is used only as a disposable source account for
 * read-only simulations (`verifyTicket`, `getEvent`) — those contract
 * functions never call `require_auth`, so no signature from it is ever
 * required or requested.
 */
/** How long a cached platform-signer account is reused for simulation. */
const PLATFORM_ACCOUNT_CACHE_TTL_MS = 30_000;

/**
 * #520 — how long the contract's resale platform fee is cached. The fee is an
 * admin setting that rarely changes, and the marketplace reads it on every
 * page, so one RPC simulation a minute is plenty.
 */
const RESALE_FEE_CACHE_TTL_MS = 60_000;

/** Default Soroban transaction time-bound for `build*Tx`, in seconds. */
const DEFAULT_BUILD_TX_TIMEOUT_SECONDS = 300;

/** Default window `submitSignedTransaction` polls for a result, in seconds. */
const DEFAULT_POLL_TIMEOUT_SECONDS = 15;

/** Interval between `getTransaction` polls while awaiting a result. */
const POLL_INTERVAL_MS = 1_000;

/** #384 — Max retry attempts when `sendTransaction` returns TRY_AGAIN_LATER. */
const MAX_SUBMIT_RETRIES = 3;

/** #384 — Initial backoff delay in ms when retrying TRY_AGAIN_LATER. */
const INITIAL_SUBMIT_BACKOFF_MS = 1_000;

/** #145 — Default per-call Soroban RPC timeout. Override with SOROBAN_RPC_TIMEOUT_MS. */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * Default ceiling on the platform-paid fee for one sponsored attendee
 * transaction, in stroops (100_000 = 0.01 XLM). Override with
 * FEE_BUMP_MAX_FEE_STROOPS.
 */
const DEFAULT_FEE_BUMP_MAX_FEE_STROOPS = 100_000;

/** Options for `submitSignedTransaction`. */
export interface SubmitOptions {
  /** Wrap the envelope in a platform-funded fee bump (#161). Off by default. */
  sponsorFee?: boolean;
}

/** #143 — capped retries for a transient RPC call, before the circuit breaker sees it. */
const MAX_RPC_RETRIES = 3;
const INITIAL_RPC_BACKOFF_MS = 200;

/** Network errors (no HTTP response) and 5xx — not a 4xx, which won't succeed on retry. */
function isRetryableRpcError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)
    ?.response?.status;
  if (status !== undefined) return status >= 500;
  return true; // no response at all: DNS, connection reset, timeout, etc.
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  initialBackoffMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetryableRpcError(error)) throw error;
      const backoff = initialBackoffMs * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.3;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
  throw lastError;
}

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly platformSigner: Keypair;
  /** Time bound set on every `build*Tx` envelope; it can't land after this many seconds. */
  readonly buildTxTimeoutSeconds: number;
  private readonly pollTimeoutSeconds: number;
  private readonly feeBumpMaxFeeStroops: number;
  private readonly rpcCircuitBreaker = new CircuitBreaker();
  private platformAccountCache: {
    account: Awaited<ReturnType<rpc.Server['getAccount']>>;
    expiresAt: number;
  } | null = null;
  private resaleFeeCache: { bps: number; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.getOrThrow<string>('SOROBAN_RPC_URL');
    const network = this.config.getOrThrow<StellarNetwork>('STELLAR_NETWORK');
    const rpcTimeoutMs =
      this.config.get<number>('SOROBAN_RPC_TIMEOUT_MS') ??
      DEFAULT_RPC_TIMEOUT_MS;
    this.server = new rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith('http://'),
      timeout: rpcTimeoutMs,
    });
    this.contractId = this.config.getOrThrow<string>('TICKETING_CONTRACT_ID');
    this.contract = new Contract(this.contractId);
    this.networkPassphrase = NETWORK_PASSPHRASES[network];
    this.platformSigner = Keypair.fromSecret(
      this.config.getOrThrow<string>('PLATFORM_SIGNER_SECRET'),
    );
    this.buildTxTimeoutSeconds =
      this.config.get<number>('TRANSACTION_BUILD_TIMEOUT_SECONDS') ??
      DEFAULT_BUILD_TX_TIMEOUT_SECONDS;
    this.pollTimeoutSeconds =
      this.config.get<number>('TRANSACTION_POLL_TIMEOUT_SECONDS') ??
      DEFAULT_POLL_TIMEOUT_SECONDS;
    this.feeBumpMaxFeeStroops =
      this.config.get<number>('FEE_BUMP_MAX_FEE_STROOPS') ??
      DEFAULT_FEE_BUMP_MAX_FEE_STROOPS;

    this.logger.log(
      `StellarService initialized: networkPassphrase='${this.networkPassphrase}', contractId='${this.contractId}'`,
    );
  }

  /** Get cached network passphrase (Issue #151). */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /** Get cached contract ID (Issue #151). */
  getContractId(): string {
    return this.contractId;
  }

  getCircuitBreakerMetrics() {
    return this.rpcCircuitBreaker.metrics();
  }

  /**
   * Poll/check status of a transaction by hash (Issue #149).
   */
  async getTransactionStatus(
    txHash: string,
  ): Promise<{ status: string; latestLedger?: number; resultXdr?: string }> {
    const tx = await this.rpcCall(() => this.server.getTransaction(txHash));
    const resultXdr = 'resultXdr' in tx ? tx.resultXdr : undefined;
    return {
      status: tx.status,
      latestLedger: tx.latestLedger,
      // Only a landed (SUCCESS / FAILED) transaction carries a result.
      resultXdr:
        tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND
          ? undefined
          : tx.resultXdr.toXDR('base64'),
      resultXdr: resultXdr?.toXDR('base64'),
    };
  }

  /** Read-only simulation — no signature, no ledger write, no fee. */
  async verifyTicket(chainTicketId: bigint): Promise<OnChainTicket> {
    const result = await this.simulateRead(
      'verify_ticket',
      contractArgs('verify_ticket', { ticket_id: chainTicketId }),
    );
    return this.decodeTicket(result);
  }

  async getEvent(chainEventId: bigint): Promise<OnChainEvent> {
    const result = await this.simulateRead(
      'get_event',
      contractArgs('get_event', { event_id: chainEventId }),
    );
    return { eventId: chainEventId, ...this.decodeEvent(result) };
  }

  /**
   * #520 — the platform fee `buy_resale` takes from each resale, in basis
   * points: `platform_fee().resale_bps`, or 0 when no fee is configured.
   *
   * Cached for a minute. When the RPC read fails, the last known value is
   * returned if there is one; otherwise the error propagates so callers can
   * decide not to show proceeds rather than show wrong ones.
   */
  async getResaleFeeBps(): Promise<number> {
    const now = Date.now();
    if (this.resaleFeeCache && this.resaleFeeCache.expiresAt > now) {
      return this.resaleFeeCache.bps;
    }
    try {
      const result = await this.simulateRead('platform_fee', []);
      const native = scValToNative(result) as {
        resale_bps?: number;
      } | null;
      const bps = Number(native?.resale_bps ?? 0);
      this.resaleFeeCache = { bps, expiresAt: now + RESALE_FEE_CACHE_TTL_MS };
      return bps;
    } catch (err) {
      if (this.resaleFeeCache) {
        this.logger.warn(
          `Could not refresh the resale fee, using the last known value: ${(err as Error).message}`,
        );
        return this.resaleFeeCache.bps;
      }
      throw err;
    }
  }

  /**
   * Pings the Soroban RPC directly — no retry, no circuit breaker — so the
   * latency and up/down result reflect the RPC's real state right now (#147).
   */
  async pingRpc(): Promise<{ up: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.server.getLatestLedger();
      return { up: true, latencyMs: Date.now() - start };
    } catch {
      return { up: false, latencyMs: Date.now() - start };
    }
  }

  buildCreateEventTx(params: {
    organizerPublicKey: string;
    chainEventId: bigint;
    name: string;
    category: string;
    maxResaleMultiplierBps: number;
    royaltyBps: number;
    startsAt: bigint;
    transferFreezeSeconds?: bigint;
    resaleCutoffSeconds?: bigint;
    maxPerWallet?: number | null;
  }): Promise<string> {
    const eventParams: EventParams = {
      name: params.name,
      category: params.category,
      max_resale_multiplier_bps: params.maxResaleMultiplierBps,
      royalty_bps: params.royaltyBps,
      starts_at: params.startsAt,
      transfer_freeze_seconds: params.transferFreezeSeconds ?? 0n,
      resale_cutoff_seconds: params.resaleCutoffSeconds ?? 0n,
      max_per_wallet: params.maxPerWallet ?? null,
      refund_window_seconds: null,
      presale_starts_at: null,
      presale_ends_at: null,
    };
    return this.buildTx(
      params.organizerPublicKey,
      'create_event',
      encodeCreateEvent({
        organizer: params.organizerPublicKey,
        eventId: params.chainEventId,
        params: eventParams,
      }),
    );
  }

  buildIssueTicketTx(params: {
    organizerPublicKey: string;
    chainEventId: bigint;
    toPublicKey: string;
    tier: string;
    seat: string;
    price: bigint;
  }): Promise<string> {
    return this.buildTx(
      params.organizerPublicKey,
      'issue_ticket',
      encodeIssueTicket({
        organizer: params.organizerPublicKey,
        eventId: params.chainEventId,
        to: params.toPublicKey,
        tier: params.tier,
        seat: params.seat,
        price: params.price,
      }),
    );
  }

  buildPurchasePrimaryTx(params: {
    buyerPublicKey: string;
    chainEventId: bigint;
    tier: string;
    seat: string;
  }): Promise<string> {
    return this.buildTx(
      params.buyerPublicKey,
      'purchase_primary',
      encodePurchasePrimary({
        buyer: params.buyerPublicKey,
        eventId: params.chainEventId,
        tier: params.tier,
        seat: params.seat,
      }),
    );
  }

  buildTransferTicketTx(params: {
    fromPublicKey: string;
    chainTicketId: bigint;
    toPublicKey: string;
  }): Promise<string> {
    return this.buildTx(
      params.fromPublicKey,
      'transfer_ticket',
      encodeTransferTicket({
        from: params.fromPublicKey,
        ticketId: params.chainTicketId,
        to: params.toPublicKey,
      }),
    );
  }

  buildCheckInTx(params: {
    organizerPublicKey: string;
    chainTicketId: bigint;
  }): Promise<string> {
    return this.buildTx(
      params.organizerPublicKey,
      'check_in',
      encodeCheckIn({
        organizer: params.organizerPublicKey,
        ticketId: params.chainTicketId,
      }),
    );
  }

  buildRevokeTicketTx(params: {
    organizerPublicKey: string;
    chainTicketId: bigint;
  }): Promise<string> {
    return this.buildTx(
      params.organizerPublicKey,
      'revoke_ticket',
      encodeRevokeTicket({
        organizer: params.organizerPublicKey,
        ticketId: params.chainTicketId,
      }),
    );
  }

  /**
   * #499 — builds one `revoke_batch` envelope for at most
   * `REVOKE_BATCH_CHUNK_SIZE` tickets. Callers split larger revocations into
   * ordered chunks; the contract rejects bigger batches with `BatchTooLarge`.
   */
  async buildRevokeBatchTx(params: {
    organizerPublicKey: string;
    chainTicketIds: bigint[];
  }): Promise<string> {
    if (params.chainTicketIds.length === 0) {
      throw new Error('Cannot build an empty revoke_batch transaction');
    }
    if (params.chainTicketIds.length > REVOKE_BATCH_CHUNK_SIZE) {
      throw new Error(
        `revoke_batch accepts at most ${REVOKE_BATCH_CHUNK_SIZE} tickets`,
      );
    }
    return this.buildTx(
      params.organizerPublicKey,
      'revoke_batch',
      encodeRevokeBatch({
        organizer: params.organizerPublicKey,
        ticketIds: params.chainTicketIds,
      }),
    );
  }

  buildListForResaleTx(params: {
    ownerPublicKey: string;
    chainTicketId: bigint;
    price: bigint;
  }): Promise<string> {
    return this.buildTx(
      params.ownerPublicKey,
      'list_for_resale',
      encodeListForResale({
        owner: params.ownerPublicKey,
        ticketId: params.chainTicketId,
        price: params.price,
      }),
    );
  }

  buildCancelResaleTx(params: {
    ownerPublicKey: string;
    chainTicketId: bigint;
  }): Promise<string> {
    return this.buildTx(
      params.ownerPublicKey,
      'cancel_resale',
      encodeCancelResale({
        owner: params.ownerPublicKey,
        ticketId: params.chainTicketId,
      }),
    );
  }

  buildBuyResaleTx(params: {
    buyerPublicKey: string;
    chainTicketId: bigint;
  }): Promise<string> {
    return this.buildTx(
      params.buyerPublicKey,
      'buy_resale',
      encodeBuyResale({
        buyer: params.buyerPublicKey,
        ticketId: params.chainTicketId,
      }),
    );
  }

  /**
   * Submits a wallet-signed XDR envelope (produced from one of the `build*Tx`
   * methods above and signed client-side) and polls it through to a result.
   */
  async submitSignedTransaction(
    signedXdr: string,
    options: SubmitOptions = {},
  ): Promise<{ result: unknown; txHash: string }> {
    const tx = options.sponsorFee
      ? this.sponsorFee(signedXdr)
      : TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const txHash = tx.hash().toString('hex');

    let sendResult: rpc.Api.SendTransactionResponse | undefined;
    let attempts = 0;
    let delay = INITIAL_SUBMIT_BACKOFF_MS;

    while (attempts <= MAX_SUBMIT_RETRIES) {
      sendResult = await this.rpcCall(() => this.server.sendTransaction(tx));

      if (sendResult.status === 'TRY_AGAIN_LATER') {
        attempts++;
        if (attempts <= MAX_SUBMIT_RETRIES) {
          this.logger.warn(
            `Soroban RPC returned TRY_AGAIN_LATER for tx ${txHash} (attempt ${attempts}/${MAX_SUBMIT_RETRIES}); retrying in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 4_000);
          continue;
        }
        throw new Error(
          `Soroban submission failed: TRY_AGAIN_LATER after ${MAX_SUBMIT_RETRIES} retries`,
        );
      }

      break;
    }

    if (!sendResult) {
      throw new Error('Soroban submission failed: no response from RPC');
    }

    if (sendResult.status === 'ERROR') {
      throw new Error(
        `Soroban submission failed: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }

    if (sendResult.status === 'DUPLICATE') {
      this.logger.log(
        `Transaction ${txHash} already submitted (DUPLICATE); polling existing hash`,
      );
    }

    const finalHash = sendResult.hash || txHash;
    const pollAttempts = Math.ceil(
      (this.pollTimeoutSeconds * 1000) / POLL_INTERVAL_MS,
    );
    const returnValue = await this.pollTransaction(finalHash, pollAttempts);
    return { result: scValToNative(returnValue), txHash: finalHash };
  }

  /**
   * Decodes a wallet-signed envelope down to the ticketing-contract call it
   * carries, so callers can check the signed arguments against the request
   * before trusting either (#375, #376, #377). Throws unless the envelope is
   * a single `invokeHostFunction` call on the configured contract — the only
   * shape `build*Tx` ever produces.
   */
  /**
   * Hex hash of the wallet-signed envelope. Stable for a given envelope, so
   * it identifies a confirm request across replays (#159).
   */
  txHashOf(signedXdr: string): string {
    return TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase)
      .hash()
      .toString('hex');
  }

  /**
   * #161 — wraps the attendee's signed envelope in a fee bump the platform
   * pays for. The declared fee is the spending cap: the network charges only
   * what the inner transaction actually needs, never more than the cap.
   */
  private sponsorFee(signedXdr: string): FeeBumpTransaction {
    const inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(inner instanceof Transaction)) {
      throw new Error('Envelope is already a fee bump');
    }
    if (Number(inner.fee) > this.feeBumpMaxFeeStroops) {
      throw new Error(
        `Transaction fee ${inner.fee} exceeds the sponsorship cap of ${this.feeBumpMaxFeeStroops} stroops`,
      );
    }
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      this.platformSigner,
      this.feeBumpMaxFeeStroops.toString(),
      inner,
      this.networkPassphrase,
    );
    feeBump.sign(this.platformSigner);
    return feeBump;
  }

  /**
   * One page of ticketing-contract events after `cursor`. Without a cursor,
   * reads from the latest ledger so a first run does not replay history the
   * RPC node may have pruned (#163).
   */
  async getTicketEvents(
    cursor: string | undefined,
    limit: number,
  ): Promise<ChainTicketEventPage> {
    const start = cursor
      ? { cursor }
      : {
          startLedger: (await this.rpcCall(() => this.server.getLatestLedger()))
            .sequence,
        };
    const response = await this.rpcCall(() =>
      this.server.getEvents({
        ...start,
        filters: [
          { type: 'contract', contractIds: [this.contract.contractId()] },
        ],
        limit,
      }),
    );
    return {
      events: response.events.map((event) => this.decodeTicketEvent(event)),
      latestLedger: response.latestLedger,
    };
  }

  decodeSignedInvocation(signedXdr: string): SignedInvocation {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const inner = tx instanceof Transaction ? tx : tx.innerTransaction;
    if (inner.operations.length !== 1) {
      throw new Error(`Expected one operation, got ${inner.operations.length}`);
    }
    const [operation] = inner.operations;
    if (operation.type !== 'invokeHostFunction') {
      throw new Error(`Expected invokeHostFunction, got ${operation.type}`);
    }
    if (
      operation.func.switch() !==
      xdr.HostFunctionType.hostFunctionTypeInvokeContract()
    ) {
      throw new Error('Expected a contract invocation');
    }
    const invocation = operation.func.invokeContract();
    const contractId = Address.fromScAddress(
      invocation.contractAddress(),
    ).toString();
    if (contractId !== this.contract.contractId()) {
      throw new Error(`Envelope targets an unexpected contract ${contractId}`);
    }
    return {
      functionName: invocation.functionName().toString(),
      args: invocation.args().map((arg) => scValToNative(arg) as unknown),
    };
  }

  /**
   * Returns a cached `Account` for the platform signer, refetching only
   * after the TTL expires. Simulation never submits a transaction, so the
   * sequence number does not need to be live -- there is no benefit to a
   * round trip to `getAccount` on every `verifyTicket`/`getEvent` call.
   */
  private async getPlatformAccount() {
    const now = Date.now();
    if (
      this.platformAccountCache &&
      this.platformAccountCache.expiresAt > now
    ) {
      return this.platformAccountCache.account;
    }
    const account = await this.rpcCall(() =>
      this.server.getAccount(this.platformSigner.publicKey()),
    );
    this.platformAccountCache = {
      account,
      expiresAt: now + PLATFORM_ACCOUNT_CACHE_TTL_MS,
    };
    return account;
  }

  private async simulateRead(fn: string, args: xdr.ScVal[]) {
    const account = await this.getPlatformAccount();
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(fn, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.rpcCall(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Soroban simulation failed for ${fn}: ${sim.error}`);
    }
    if (!sim.result) {
      throw new Error(`Soroban simulation for ${fn} returned no result`);
    }
    return sim.result.retval;
  }

  /** Simulates + assigns fees/footprint for `fn`, returning an unsigned XDR envelope. */
  private async buildTx(
    sourcePublicKey: string,
    fn: string,
    args: xdr.ScVal[],
  ): Promise<string> {
    try {
      const account = await this.rpcCall(() =>
        this.server.getAccount(sourcePublicKey),
      );
      const built = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(fn, ...args))
        .setTimeout(this.buildTxTimeoutSeconds)
        .build();

      // Issue #153: Simulate transaction before returning build payload
      const sim = await this.rpcCall(() =>
        this.server.simulateTransaction(built),
      );
      if (rpc.Api.isSimulationError(sim)) {
        throw mapSorobanErrorToApiException(sim.error);
      }

      const prepared = await this.rpcCall(() =>
        this.server.prepareTransaction(built),
      );
      return prepared.toXDR();
    } catch (err) {
      if (err && typeof err === 'object' && 'getStatus' in err) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw mapSorobanErrorToApiException(msg);
    }
  }

  private async pollTransaction(
    hash: string,
    attempts: number,
  ): Promise<xdr.ScVal> {
    for (let i = 0; i < attempts; i++) {
      const tx = await this.rpcCall(() => this.server.getTransaction(hash));
      if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        if (!tx.returnValue) {
          throw new Error(
            `Transaction ${hash} succeeded without a return value`,
          );
        }
        return tx.returnValue;
      }
      if (tx.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${hash} failed on-chain`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for transaction ${hash} to land`);
  }

  private decodeTicketEvent(event: rpc.Api.EventResponse): ChainTicketEvent {
    const name = String(scValToNative(event.topic[0]));
    // Payload shape is assumed: a bare u64 ticket id, or a map with a
    // `ticket_id` field. Confirm against the contract's emitted events.
    const payload = scValToNative(event.value) as unknown;
    const raw =
      typeof payload === 'bigint'
        ? payload
        : (payload as { ticket_id?: unknown } | null)?.ticket_id;
    return {
      id: event.id,
      // stellar-sdk 14+ dropped `pagingToken` from `getEvents` results; the
      // event id is the RPC's pagination cursor. Reading the old field stored
      // `undefined` as the indexer cursor, so the cursor upsert failed.
      pagingToken: event.id,
      pagingToken:
        (event as unknown as { pagingToken?: string }).pagingToken ?? event.id,
      ledger: event.ledger,
      name,
      chainTicketId: typeof raw === 'bigint' ? raw : null,
    };
  }

  private rpcCall<T>(operation: () => Promise<T>): Promise<T> {
    return this.rpcCircuitBreaker.execute(() =>
      withRetry(operation, MAX_RPC_RETRIES, INITIAL_RPC_BACKOFF_MS),
    );
  }

  private decodeTicket(scVal: xdr.ScVal): OnChainTicket {
    const native = scValToNative(scVal) as Record<string, unknown>;
    return {
      eventId: native.event_id as bigint,
      owner: native.owner as string,
      tier: native.tier as string,
      seat: native.seat as string,
      status: this.decodeStatus(native.status),
      originalPrice: native.original_price as bigint,
      resalePrice: native.resale_price as bigint,
    };
  }

  private decodeEvent(scVal: xdr.ScVal): Omit<OnChainEvent, 'eventId'> {
    const native = scValToNative(scVal) as Record<string, unknown>;
    return {
      organizer: native.organizer as string,
      name: native.name as string,
      category: native.category as string,
      maxResaleMultiplierBps: native.max_resale_multiplier_bps as number,
      royaltyBps: native.royalty_bps as number,
      ticketsIssued: native.tickets_issued as bigint,
    };
  }

  private decodeStatus(raw: unknown): OnChainTicket['status'] {
    // soroban_sdk unit-variant enums decode as either a bare tag string or
    // `{ tag: string }` depending on SDK version — handle both.
    const tag = typeof raw === 'string' ? raw : (raw as { tag: string })?.tag;
    if (
      tag === 'Valid' ||
      tag === 'Used' ||
      tag === 'Revoked' ||
      tag === 'Resale'
    ) {
      return tag;
    }
    this.logger.warn(
      `Unrecognized on-chain ticket status: ${JSON.stringify(raw)}`,
    );
    return 'Valid';
  }
}

import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  nativeToScVal,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  createStellarHarness,
  decodeInvokeHostFunction,
  NETWORK_PASSPHRASES,
  signAsWallet,
  TEST_CONTRACT_ID,
} from '../../test/helpers/stellar-harness';
import {
  eventScVal,
  sendDuplicate,
  sendPending,
  sendRejected,
  sendTryAgainLater,
  simulationError,
  simulationSuccess,
  ticketScVal,
  TX_HASH,
  txFailed,
  txNotFound,
  txSuccess,
} from '../../test/mocks/soroban-rpc.mock';
import { CircuitOpenError } from './circuit-breaker';
import type { StellarService } from './stellar.service';

const organizer = Keypair.random();
const attendee = Keypair.random();
const buyer = Keypair.random();
const ORGANIZER = organizer.publicKey();
const ATTENDEE = attendee.publicKey();
const BUYER = buyer.publicKey();
const CHAIN_EVENT_ID = 42n;
const CHAIN_TICKET_ID = 7n;

describe('StellarService (contract-mock harness)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('build*Tx envelopes', () => {
    const cases: Array<{
      method: string;
      build: (service: StellarService) => Promise<string>;
      source: string;
      fn: string;
      args: unknown[];
      argTypes: string[];
    }> = [
      {
        method: 'buildCreateEventTx',
        build: (s) =>
          s.buildCreateEventTx({
            organizerPublicKey: ORGANIZER,
            chainEventId: CHAIN_EVENT_ID,
            name: 'Launch Night',
            category: 'CONCERTS',
            maxResaleMultiplierBps: 11_000,
            royaltyBps: 500,
            startsAt: 100n,
          }),
        source: ORGANIZER,
        fn: 'create_event',
        args: [
          ORGANIZER,
          CHAIN_EVENT_ID,
          {
            name: 'Launch Night',
            category: 'CONCERTS',
            max_resale_multiplier_bps: 11_000,
            royalty_bps: 500,
            starts_at: 100n,
            transfer_freeze_seconds: 0n,
            resale_cutoff_seconds: 0n,
            max_per_wallet: null,
            refund_window_seconds: null,
            presale_starts_at: null,
            presale_ends_at: null,
          },
        ],
        argTypes: ['scvAddress', 'scvU64', 'scvMap'],
      },
      {
        method: 'buildIssueTicketTx',
        build: (s) =>
          s.buildIssueTicketTx({
            organizerPublicKey: ORGANIZER,
            chainEventId: CHAIN_EVENT_ID,
            toPublicKey: ATTENDEE,
            tier: 'GA',
            seat: 'A-12',
            price: 1_000_000n,
          }),
        source: ORGANIZER,
        fn: 'issue_ticket',
        args: [ORGANIZER, CHAIN_EVENT_ID, ATTENDEE, 'GA', 'A-12', 1_000_000n],
        argTypes: [
          'scvAddress',
          'scvU64',
          'scvAddress',
          'scvString',
          'scvString',
          'scvI128',
        ],
      },
      {
        method: 'buildPurchasePrimaryTx',
        build: (s) =>
          s.buildPurchasePrimaryTx({
            buyerPublicKey: BUYER,
            chainEventId: CHAIN_EVENT_ID,
            tier: 'GA',
            seat: 'unassigned',
          }),
        source: BUYER,
        fn: 'purchase_primary',
        args: [BUYER, CHAIN_EVENT_ID, 'GA', 'unassigned'],
        argTypes: ['scvAddress', 'scvU64', 'scvString', 'scvString'],
      },
      {
        method: 'buildTransferTicketTx',
        build: (s) =>
          s.buildTransferTicketTx({
            fromPublicKey: ATTENDEE,
            chainTicketId: CHAIN_TICKET_ID,
            toPublicKey: BUYER,
          }),
        source: ATTENDEE,
        fn: 'transfer_ticket',
        args: [ATTENDEE, CHAIN_TICKET_ID, BUYER],
        argTypes: ['scvAddress', 'scvU64', 'scvAddress'],
      },
      {
        method: 'buildCheckInTx',
        build: (s) =>
          s.buildCheckInTx({
            organizerPublicKey: ORGANIZER,
            chainTicketId: CHAIN_TICKET_ID,
          }),
        source: ORGANIZER,
        fn: 'check_in',
        args: [ORGANIZER, CHAIN_TICKET_ID],
        argTypes: ['scvAddress', 'scvU64'],
      },
      {
        method: 'buildRevokeTicketTx',
        build: (s) =>
          s.buildRevokeTicketTx({
            organizerPublicKey: ORGANIZER,
            chainTicketId: CHAIN_TICKET_ID,
          }),
        source: ORGANIZER,
        fn: 'revoke_ticket',
        args: [ORGANIZER, CHAIN_TICKET_ID],
        argTypes: ['scvAddress', 'scvU64'],
      },
      {
        method: 'buildRevokeBatchTx',
        build: (s) =>
          s.buildRevokeBatchTx({
            organizerPublicKey: ORGANIZER,
            chainTicketIds: [CHAIN_TICKET_ID, 8n],
          }),
        source: ORGANIZER,
        fn: 'revoke_batch',
        args: [ORGANIZER, [CHAIN_TICKET_ID, 8n]],
        argTypes: ['scvAddress', 'scvVec'],
      },
      {
        method: 'buildListForResaleTx',
        build: (s) =>
          s.buildListForResaleTx({
            ownerPublicKey: ATTENDEE,
            chainTicketId: CHAIN_TICKET_ID,
            price: 3_000_000n,
          }),
        source: ATTENDEE,
        fn: 'list_for_resale',
        args: [ATTENDEE, CHAIN_TICKET_ID, 3_000_000n],
        argTypes: ['scvAddress', 'scvU64', 'scvI128'],
      },
      {
        method: 'buildCancelResaleTx',
        build: (s) =>
          s.buildCancelResaleTx({
            ownerPublicKey: ATTENDEE,
            chainTicketId: CHAIN_TICKET_ID,
          }),
        source: ATTENDEE,
        fn: 'cancel_resale',
        args: [ATTENDEE, CHAIN_TICKET_ID],
        argTypes: ['scvAddress', 'scvU64'],
      },
      {
        method: 'buildBuyResaleTx',
        build: (s) =>
          s.buildBuyResaleTx({
            buyerPublicKey: BUYER,
            chainTicketId: CHAIN_TICKET_ID,
          }),
        source: BUYER,
        fn: 'buy_resale',
        args: [BUYER, CHAIN_TICKET_ID],
        argTypes: ['scvAddress', 'scvU64'],
      },
    ];

    it.each(cases)(
      '$method encodes a $fn call on the ticketing contract',
      async ({ build, source, fn, args, argTypes }) => {
        const { service, server } = createStellarHarness();

        const envelope = await build(service);
        const decoded = decodeInvokeHostFunction(envelope, Networks.TESTNET);

        expect(decoded).toMatchObject({
          source,
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
          contractId: TEST_CONTRACT_ID,
          functionName: fn,
          args,
          argTypes,
          signatureCount: 0,
        });
        expect(server.getAccount).toHaveBeenCalledWith(source);
        expect(server.prepareTransaction).toHaveBeenCalledTimes(1);
      },
    );

    it('rejects a revoke_batch envelope larger than the contract limit', async () => {
      const { service } = createStellarHarness();
      await expect(
        service.buildRevokeBatchTx({
          organizerPublicKey: ORGANIZER,
          chainTicketIds: Array.from({ length: 36 }, (_, i) => BigInt(i)),
        }),
      ).rejects.toThrow(/at most 35/);
    });

    it('returns the envelope prepareTransaction produced, not the pre-simulation one', async () => {
      const { service, server } = createStellarHarness();
      server.prepareTransaction.mockImplementation((tx) =>
        Promise.resolve(
          TransactionBuilder.cloneFrom(tx, { fee: '5000' }).build(),
        ),
      );

      const envelope = await service.buildCheckInTx({
        organizerPublicKey: ORGANIZER,
        chainTicketId: CHAIN_TICKET_ID,
      });

      expect(decodeInvokeHostFunction(envelope, Networks.TESTNET).fee).toBe(
        '5000',
      );
    });

    it('gives the wallet a five-minute window to sign by default', async () => {
      const { service } = createStellarHarness();
      const before = Math.floor(Date.now() / 1000);

      const envelope = await service.buildCheckInTx({
        organizerPublicKey: ORGANIZER,
        chainTicketId: CHAIN_TICKET_ID,
      });

      const { timeBounds } = decodeInvokeHostFunction(
        envelope,
        Networks.TESTNET,
      );
      expect(timeBounds.minTime).toBe(0);
      expect(timeBounds.maxTime).toBeGreaterThanOrEqual(before + 300);
      expect(timeBounds.maxTime).toBeLessThanOrEqual(before + 305);
    });

    it('honors TRANSACTION_BUILD_TIMEOUT_SECONDS instead of the fixed 300s default', async () => {
      const { service } = createStellarHarness({ buildTimeoutSeconds: 60 });
      const before = Math.floor(Date.now() / 1000);

      const envelope = await service.buildCheckInTx({
        organizerPublicKey: ORGANIZER,
        chainTicketId: CHAIN_TICKET_ID,
      });

      const { timeBounds } = decodeInvokeHostFunction(
        envelope,
        Networks.TESTNET,
      );
      expect(timeBounds.maxTime).toBeGreaterThanOrEqual(before + 60);
      expect(timeBounds.maxTime).toBeLessThanOrEqual(before + 65);
    });

    it('binds the envelope to the configured network so a wallet on another network cannot sign it', async () => {
      const { service } = createStellarHarness({ network: 'futurenet' });

      const envelope = await service.buildCheckInTx({
        organizerPublicKey: ORGANIZER,
        chainTicketId: CHAIN_TICKET_ID,
      });

      const onFuturenet = TransactionBuilder.fromXDR(
        envelope,
        Networks.FUTURENET,
      );
      const onTestnet = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
      expect(onFuturenet.networkPassphrase).toBe(Networks.FUTURENET);
      expect(onFuturenet.hash().toString('hex')).not.toBe(
        onTestnet.hash().toString('hex'),
      );
    });

    it.each(Object.entries(NETWORK_PASSPHRASES))(
      'maps STELLAR_NETWORK=%s to its passphrase',
      async (network, passphrase) => {
        const { service } = createStellarHarness({
          network: network as keyof typeof NETWORK_PASSPHRASES,
        });

        const envelope = await service.buildCheckInTx({
          organizerPublicKey: ORGANIZER,
          chainTicketId: CHAIN_TICKET_ID,
        });

        expect(
          decodeInvokeHostFunction(envelope, passphrase).networkPassphrase,
        ).toBe(passphrase);
      },
    );

    it('propagates an RPC failure while resolving the source account', async () => {
      const { service, server } = createStellarHarness();
      server.getAccount.mockRejectedValue(new Error('account not found'));

      await expect(
        service.buildCheckInTx({
          organizerPublicKey: ORGANIZER,
          chainTicketId: CHAIN_TICKET_ID,
        }),
      ).rejects.toThrow('account not found');
      expect(server.prepareTransaction).not.toHaveBeenCalled();
    });
  });

  describe('submitSignedTransaction', () => {
    async function signedIssueEnvelope(service: StellarService) {
      const unsigned = await service.buildIssueTicketTx({
        organizerPublicKey: ORGANIZER,
        chainEventId: CHAIN_EVENT_ID,
        toPublicKey: ATTENDEE,
        tier: 'GA',
        seat: 'A-12',
        price: 1_000_000n,
      });
      return signAsWallet(unsigned, Networks.TESTNET, organizer);
    }

    it('relays the wallet-signed envelope and returns the decoded return value with its hash', async () => {
      const { service, server } = createStellarHarness();
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction.mockResolvedValue(
        txSuccess(nativeToScVal(CHAIN_TICKET_ID, { type: 'u64' })),
      );
      const signed = await signedIssueEnvelope(service);

      const result = await service.submitSignedTransaction(signed);

      expect(result).toEqual({ result: CHAIN_TICKET_ID, txHash: TX_HASH });
      const relayed = server.sendTransaction.mock.calls[0][0];
      const expected = TransactionBuilder.fromXDR(
        signed,
        Networks.TESTNET,
      ) as Transaction;
      expect(relayed.hash().toString('hex')).toBe(
        expected.hash().toString('hex'),
      );
      expect(relayed.signatures).toHaveLength(1);
      expect(
        decodeInvokeHostFunction(relayed.toXDR(), Networks.TESTNET)
          .functionName,
      ).toBe('issue_ticket');
      expect(server.getTransaction).toHaveBeenCalledWith(TX_HASH);
    });

    it('throws when the network rejects the submission', async () => {
      const { service, server } = createStellarHarness();
      server.sendTransaction.mockResolvedValue(sendRejected());

      await expect(
        service.submitSignedTransaction(await signedIssueEnvelope(service)),
      ).rejects.toThrow(/Soroban submission failed: .*txBAD_SEQ/);
      expect(server.getTransaction).not.toHaveBeenCalled();
    });

    it('handles DUPLICATE by polling the existing transaction hash (#384)', async () => {
      const { service, server } = createStellarHarness();
      server.sendTransaction.mockResolvedValue(sendDuplicate());
      server.getTransaction.mockResolvedValue(
        txSuccess(nativeToScVal(CHAIN_TICKET_ID, { type: 'u64' })),
      );
      const signed = await signedIssueEnvelope(service);

      const result = await service.submitSignedTransaction(signed);

      expect(result).toEqual({ result: CHAIN_TICKET_ID, txHash: TX_HASH });
      expect(server.sendTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(TX_HASH);
    });

    it('retries TRY_AGAIN_LATER with backoff and succeeds when subsequent attempt returns PENDING (#384)', async () => {
      const { service, server } = createStellarHarness();
      const signed = await signedIssueEnvelope(service);
      jest.useFakeTimers();

      server.sendTransaction
        .mockResolvedValueOnce(sendTryAgainLater())
        .mockResolvedValueOnce(sendPending());
      server.getTransaction.mockResolvedValue(
        txSuccess(nativeToScVal(CHAIN_TICKET_ID, { type: 'u64' })),
      );

      const pending = service.submitSignedTransaction(signed);
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({
        result: CHAIN_TICKET_ID,
        txHash: TX_HASH,
      });
      expect(server.sendTransaction).toHaveBeenCalledTimes(2);
      expect(server.getTransaction).toHaveBeenCalledWith(TX_HASH);
    });

    it('fails fast when TRY_AGAIN_LATER persists across bounded retries without polling (#384)', async () => {
      const { service, server } = createStellarHarness();
      const signed = await signedIssueEnvelope(service);
      jest.useFakeTimers();

      server.sendTransaction.mockResolvedValue(sendTryAgainLater());

      const expectation = expect(
        service.submitSignedTransaction(signed),
      ).rejects.toThrow(
        /Soroban submission failed: TRY_AGAIN_LATER after 3 retries/,
      );
      await jest.advanceTimersByTimeAsync(10_000);

      await expectation;
      expect(server.sendTransaction).toHaveBeenCalledTimes(4);
      expect(server.getTransaction).not.toHaveBeenCalled();
    });

    it('throws when the transaction fails on-chain', async () => {
      const { service, server } = createStellarHarness();
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction.mockResolvedValue(txFailed());

      await expect(
        service.submitSignedTransaction(await signedIssueEnvelope(service)),
      ).rejects.toThrow(`Transaction ${TX_HASH} failed on-chain`);
    });

    it('throws when a successful transaction carries no return value', async () => {
      const { service, server } = createStellarHarness();
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction.mockResolvedValue(txSuccess(undefined));

      await expect(
        service.submitSignedTransaction(await signedIssueEnvelope(service)),
      ).rejects.toThrow(/succeeded without a return value/);
    });

    it('polls once a second until the transaction lands', async () => {
      const { service, server } = createStellarHarness();
      const signed = await signedIssueEnvelope(service);
      jest.useFakeTimers();
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction
        .mockResolvedValueOnce(txNotFound())
        .mockResolvedValueOnce(txNotFound())
        .mockResolvedValueOnce(
          txSuccess(nativeToScVal(CHAIN_TICKET_ID, { type: 'u64' })),
        );

      const pending = service.submitSignedTransaction(signed);
      await jest.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual({
        result: CHAIN_TICKET_ID,
        txHash: TX_HASH,
      });
      expect(server.getTransaction).toHaveBeenCalledTimes(3);
    });

    it('gives up after fifteen polls', async () => {
      const { service, server } = createStellarHarness();
      const signed = await signedIssueEnvelope(service);
      jest.useFakeTimers();
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction.mockResolvedValue(txNotFound());

      const expectation = expect(
        service.submitSignedTransaction(signed),
      ).rejects.toThrow(`Timed out waiting for transaction ${TX_HASH}`);
      await jest.advanceTimersByTimeAsync(16_000);

      await expectation;
      expect(server.getTransaction).toHaveBeenCalledTimes(15);
    });

    it('honors TRANSACTION_POLL_TIMEOUT_SECONDS instead of the fixed 15-poll window', async () => {
      const { service, server } = createStellarHarness({
        pollTimeoutSeconds: 5,
      });
      const signed = await signedIssueEnvelope(service);
      jest.useFakeTimers();
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction.mockResolvedValue(txNotFound());

      const expectation = expect(
        service.submitSignedTransaction(signed),
      ).rejects.toThrow(`Timed out waiting for transaction ${TX_HASH}`);
      await jest.advanceTimersByTimeAsync(6_000);

      await expectation;
      expect(server.getTransaction).toHaveBeenCalledTimes(5);
    });

    it('rejects an envelope built for another network before touching RPC', async () => {
      const { service, server } = createStellarHarness();
      const foreign = createStellarHarness({ network: 'futurenet' });
      const unsigned = await foreign.service.buildCheckInTx({
        organizerPublicKey: ORGANIZER,
        chainTicketId: CHAIN_TICKET_ID,
      });
      const signed = signAsWallet(unsigned, Networks.FUTURENET, organizer);
      server.sendTransaction.mockResolvedValue(sendPending());
      server.getTransaction.mockResolvedValue(
        txSuccess(nativeToScVal(CHAIN_TICKET_ID, { type: 'u64' })),
      );

      // The envelope decodes, but its signature was made over the futurenet
      // hash, so it no longer verifies against the testnet passphrase.
      await service.submitSignedTransaction(signed);
      const relayed = server.sendTransaction.mock.calls[0][0];
      const signature = relayed.signatures[0].signature();
      expect(organizer.verify(relayed.hash(), signature)).toBe(false);
    });
  });

  describe('decodeSignedInvocation (#375-#377)', () => {
    it('decodes the contract call and native arguments of a signed envelope', async () => {
      const { service } = createStellarHarness();
      const unsigned = await service.buildIssueTicketTx({
        organizerPublicKey: ORGANIZER,
        chainEventId: CHAIN_EVENT_ID,
        toPublicKey: ATTENDEE,
        tier: 'GA',
        seat: 'A-12',
        price: 1_000_000n,
      });
      const signed = signAsWallet(unsigned, Networks.TESTNET, organizer);

      expect(service.decodeSignedInvocation(signed)).toEqual({
        functionName: 'issue_ticket',
        args: [ORGANIZER, CHAIN_EVENT_ID, ATTENDEE, 'GA', 'A-12', 1_000_000n],
      });
    });

    it('decodes the inner call of a fee-bump envelope', async () => {
      const { service } = createStellarHarness();
      const unsigned = await service.buildTransferTicketTx({
        fromPublicKey: ATTENDEE,
        chainTicketId: CHAIN_TICKET_ID,
        toPublicKey: BUYER,
      });
      const inner = TransactionBuilder.fromXDR(
        signAsWallet(unsigned, Networks.TESTNET, attendee),
        Networks.TESTNET,
      ) as Transaction;
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        buyer,
        '1000',
        inner,
        Networks.TESTNET,
      );
      feeBump.sign(buyer);

      expect(service.decodeSignedInvocation(feeBump.toXDR())).toEqual({
        functionName: 'transfer_ticket',
        args: [ATTENDEE, CHAIN_TICKET_ID, BUYER],
      });
    });

    it('rejects a call on a different contract', async () => {
      const { service } = createStellarHarness();
      const other = createStellarHarness({
        contractId: StrKey.encodeContract(Buffer.alloc(32, 9)),
      });
      const unsigned = await other.service.buildListForResaleTx({
        ownerPublicKey: ATTENDEE,
        chainTicketId: CHAIN_TICKET_ID,
        price: 1n,
      });

      expect(() => service.decodeSignedInvocation(unsigned)).toThrow(
        /unexpected contract/,
      );
    });

    it('rejects an envelope that is not a single contract invocation', () => {
      const { service } = createStellarHarness();
      const payment = new TransactionBuilder(new Account(ATTENDEE, '1'), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
        .setTimeout(30)
        .build();

      expect(() => service.decodeSignedInvocation(payment.toXDR())).toThrow(
        /Expected invokeHostFunction/,
      );
    });

    it('rejects an envelope with more than one operation', () => {
      const { service } = createStellarHarness();
      const tx = new TransactionBuilder(new Account(ATTENDEE, '1'), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
        .addOperation(Operation.bumpSequence({ bumpTo: '11' }))
        .setTimeout(30)
        .build();

      expect(() => service.decodeSignedInvocation(tx.toXDR())).toThrow(
        /Expected one operation, got 2/,
      );
    });

    it('rejects a host function that is not a contract invocation', () => {
      const { service } = createStellarHarness();
      const tx = new TransactionBuilder(new Account(ATTENDEE, '1'), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.uploadContractWasm({ wasm: Buffer.alloc(8) }))
        .setTimeout(30)
        .build();

      expect(() => service.decodeSignedInvocation(tx.toXDR())).toThrow(
        /Expected a contract invocation/,
      );
    });
  });

  describe('getTicketEvents', () => {
    it('uses the event id as the paging cursor, since getEvents has no pagingToken', async () => {
      const { service, server } = createStellarHarness();
      server.getEvents.mockResolvedValue({
        latestLedger: 120,
        cursor: '0000000429496733696-0000000001',
        events: [
          {
            id: '0000000429496733696-0000000001',
            ledger: 100,
            topic: [nativeToScVal('TicketCheckedIn', { type: 'symbol' })],
            value: nativeToScVal(CHAIN_TICKET_ID, { type: 'u64' }),
          },
        ],
      });

      const {
        events: [event],
        latestLedger,
      } = await service.getTicketEvents(undefined, 10);

      expect(event).toEqual({
        id: '0000000429496733696-0000000001',
        pagingToken: '0000000429496733696-0000000001',
        ledger: 100,
        name: 'TicketCheckedIn',
        chainTicketId: CHAIN_TICKET_ID,
      });
      expect(latestLedger).toBe(120);
      expect(server.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 500, limit: 10 }),
      );
    });
  });

  describe('getResaleFeeBps (#520)', () => {
    const feeScVal = (resaleBps: number) =>
      nativeToScVal(
        { primary_bps: 100, recipient: ORGANIZER, resale_bps: resaleBps },
        {
          type: {
            primary_bps: ['symbol', 'u32'],
            recipient: ['symbol', 'address'],
            resale_bps: ['symbol', 'u32'],
          },
        },
      );

    it('reads resale_bps from platform_fee, not the primary fee', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(feeScVal(250)),
      );

      await expect(service.getResaleFeeBps()).resolves.toBe(250);
      const simulated = decodeInvokeHostFunction(
        server.simulateTransaction.mock.calls[0][0].toXDR(),
        Networks.TESTNET,
      );
      expect(simulated).toMatchObject({
        functionName: 'platform_fee',
        args: [],
      });
    });

    it('is 0 when no platform fee is configured', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(nativeToScVal(null)),
      );

      await expect(service.getResaleFeeBps()).resolves.toBe(0);
    });

    it('caches the fee, and falls back to the last value when a refresh fails', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-23T00:00:00Z') });
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(feeScVal(250)),
      );

      await service.getResaleFeeBps();
      await service.getResaleFeeBps();
      expect(server.simulateTransaction).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2026-11-23T00:02:00Z'));
      server.simulateTransaction.mockResolvedValue(simulationError('boom'));
      await expect(service.getResaleFeeBps()).resolves.toBe(250);
    });

    it('throws when the fee has never been read and the RPC fails', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(simulationError('boom'));

      await expect(service.getResaleFeeBps()).rejects.toThrow(/platform_fee/);
    });
  });

  describe('read-only simulations', () => {
    it('verifyTicket simulates from the platform signer and decodes the Ticket struct', async () => {
      const { service, server, platformSigner } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          ticketScVal({
            eventId: CHAIN_EVENT_ID,
            owner: ATTENDEE,
            tier: 'GA',
            seat: 'A-12',
            status: 'Used',
            originalPrice: 1_000_000n,
            resalePrice: 0n,
          }),
        ),
      );

      const ticket = await service.verifyTicket(CHAIN_TICKET_ID);

      expect(ticket).toEqual({
        eventId: CHAIN_EVENT_ID,
        owner: ATTENDEE,
        tier: 'GA',
        seat: 'A-12',
        status: 'Used',
        originalPrice: 1_000_000n,
        resalePrice: 0n,
      });
      expect(server.getAccount).toHaveBeenCalledWith(
        platformSigner.publicKey(),
      );
      const simulated = decodeInvokeHostFunction(
        server.simulateTransaction.mock.calls[0][0].toXDR(),
        Networks.TESTNET,
      );
      expect(simulated).toMatchObject({
        source: platformSigner.publicKey(),
        functionName: 'verify_ticket',
        args: [CHAIN_TICKET_ID],
        argTypes: ['scvU64'],
        signatureCount: 0,
      });
      expect(server.prepareTransaction).not.toHaveBeenCalled();
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });

    it('decodes a status encoded as a tagged variant', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          ticketScVal(
            {
              eventId: CHAIN_EVENT_ID,
              owner: ATTENDEE,
              tier: 'VIP',
              seat: 'unassigned',
              status: 'Resale',
              originalPrice: 5_000_000n,
              resalePrice: 5_500_000n,
            },
            'tagged',
          ),
        ),
      );

      const ticket = await service.verifyTicket(CHAIN_TICKET_ID);

      expect(ticket.status).toBe('Resale');
      expect(ticket.resalePrice).toBe(5_500_000n);
    });

    it('falls back to Valid for a status it does not recognise', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          ticketScVal({
            eventId: CHAIN_EVENT_ID,
            owner: ATTENDEE,
            tier: 'GA',
            seat: 'A-12',
            status: 'Quarantined',
            originalPrice: 1_000_000n,
            resalePrice: 0n,
          }),
        ),
      );

      const ticket = await service.verifyTicket(CHAIN_TICKET_ID);

      expect(ticket.status).toBe('Valid');
    });

    it('reuses the cached platform account across several verifies instead of refetching it', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          ticketScVal({
            eventId: CHAIN_EVENT_ID,
            owner: ATTENDEE,
            tier: 'GA',
            seat: 'A-12',
            status: 'Valid',
            originalPrice: 1_000_000n,
            resalePrice: 0n,
          }),
        ),
      );

      await service.verifyTicket(CHAIN_TICKET_ID);
      await service.verifyTicket(CHAIN_TICKET_ID);
      await service.verifyTicket(CHAIN_TICKET_ID);

      expect(server.getAccount).toHaveBeenCalledTimes(1);
    });

    it('refetches the platform account once the cache TTL elapses', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          ticketScVal({
            eventId: CHAIN_EVENT_ID,
            owner: ATTENDEE,
            tier: 'GA',
            seat: 'A-12',
            status: 'Valid',
            originalPrice: 1_000_000n,
            resalePrice: 0n,
          }),
        ),
      );
      jest.useFakeTimers();

      await service.verifyTicket(CHAIN_TICKET_ID);
      jest.advanceTimersByTime(30_001);
      await service.verifyTicket(CHAIN_TICKET_ID);

      expect(server.getAccount).toHaveBeenCalledTimes(2);
    });

    it('getEvent decodes the Event struct and keeps the requested id', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationSuccess(
          eventScVal({
            organizer: ORGANIZER,
            name: 'Launch Night',
            category: 'CONCERTS',
            maxResaleMultiplierBps: 11_000,
            royaltyBps: 500,
            ticketsIssued: 128n,
          }),
        ),
      );

      const event = await service.getEvent(CHAIN_EVENT_ID);

      expect(event).toEqual({
        eventId: CHAIN_EVENT_ID,
        organizer: ORGANIZER,
        name: 'Launch Night',
        category: 'CONCERTS',
        maxResaleMultiplierBps: 11_000,
        royaltyBps: 500,
        ticketsIssued: 128n,
      });
      expect(
        decodeInvokeHostFunction(
          server.simulateTransaction.mock.calls[0][0].toXDR(),
          Networks.TESTNET,
        ),
      ).toMatchObject({ functionName: 'get_event', args: [CHAIN_EVENT_ID] });
    });

    it('surfaces a simulation error with the function name', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue(
        simulationError('HostError: Error(Contract, #3)'),
      );

      await expect(service.verifyTicket(CHAIN_TICKET_ID)).rejects.toThrow(
        'Soroban simulation failed for verify_ticket: HostError: Error(Contract, #3)',
      );
    });

    it('rejects a simulation that returns no result', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockResolvedValue({ latestLedger: 100 });

      await expect(service.getEvent(CHAIN_EVENT_ID)).rejects.toThrow(
        'Soroban simulation for get_event returned no result',
      );
    });

    it('retries a 5xx/network RPC failure with backoff, then succeeds (#143)', async () => {
      const { service, server } = createStellarHarness();
      jest.useFakeTimers();
      const event = eventScVal({
        organizer: ORGANIZER,
        name: 'Retry Night',
        category: 'CONCERTS',
        maxResaleMultiplierBps: 11_000,
        royaltyBps: 500,
        ticketsIssued: 1n,
      });
      server.simulateTransaction
        .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET')))
        .mockRejectedValueOnce(
          Object.assign(new Error('5xx'), { response: { status: 503 } }),
        )
        .mockResolvedValueOnce(simulationSuccess(event));

      const pending = service.getEvent(CHAIN_EVENT_ID);
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({ name: 'Retry Night' });
      expect(server.simulateTransaction).toHaveBeenCalledTimes(3);
    });

    it('does not retry a non-retryable (4xx-shaped) RPC failure (#143)', async () => {
      const { service, server } = createStellarHarness();
      server.simulateTransaction.mockRejectedValue(
        Object.assign(new Error('bad request'), { response: { status: 400 } }),
      );

      await expect(service.getEvent(CHAIN_EVENT_ID)).rejects.toThrow(
        'bad request',
      );
      expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaker', () => {
    it('starts closed and opens after three consecutive RPC failures', async () => {
      const { service, server } = createStellarHarness();
      expect(service.getCircuitBreakerMetrics()).toMatchObject({
        state: 'CLOSED',
        consecutiveFailures: 0,
      });
      server.getAccount.mockRejectedValue(new Error('ECONNREFUSED'));
      const params = {
        organizerPublicKey: ORGANIZER,
        chainTicketId: CHAIN_TICKET_ID,
      };

      for (let i = 0; i < 3; i += 1) {
        await expect(service.buildCheckInTx(params)).rejects.toThrow(
          'ECONNREFUSED',
        );
      }

      expect(service.getCircuitBreakerMetrics()).toMatchObject({
        state: 'OPEN',
        consecutiveFailures: 3,
        totalFailures: 3,
      });
      await expect(service.buildCheckInTx(params)).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      expect(server.getAccount).toHaveBeenCalledTimes(3);
      expect(service.getCircuitBreakerMetrics().rejectedCalls).toBe(1);
    });
  });
});

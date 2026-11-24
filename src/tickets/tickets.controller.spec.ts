import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import request from 'supertest';
import {
  AUTH,
  createControllerApp,
  server,
  TEST_USER,
} from '../../test/helpers/controller-app';
import { ScanRateLimitGuard } from '../common/guards/scan-rate-limit.guard';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

const KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const UUID = '3f2b8c1e-5d4a-4c6b-9e7f-1a2b3c4d5e6f';
const UUID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const HASH = 'a'.repeat(64);

const handlerOf = (name: keyof TicketsController): object =>
  Object.getOwnPropertyDescriptor(TicketsController.prototype, name)
    ?.value as object;

describe('TicketsController', () => {
  let app: INestApplication;
  const service = {
    findActiveResaleListings: jest.fn(),
    findMine: jest.fn(),
    verify: jest.fn(),
    getOfflinePublicKeys: jest.fn(),
    findByChainTicketId: jest.fn(),
    findOne: jest.fn(),
    getQrImage: jest.fn(),
    issueQrToken: jest.fn(),
    getOfflineToken: jest.fn(),
    buildIssueTx: jest.fn(),
    confirmIssue: jest.fn(),
    buildIssueBatch: jest.fn(),
    buildPurchaseTx: jest.fn(),
    confirmPurchase: jest.fn(),
    buildTransferTx: jest.fn(),
    confirmTransfer: jest.fn(),
    buildCheckInTx: jest.fn(),
    confirmCheckIn: jest.fn(),
    buildRevokeTx: jest.fn(),
    confirmRevoke: jest.fn(),
    buildRevokeBatch: jest.fn(),
    confirmRevokeBatch: jest.fn(),
    buildListForResaleTx: jest.fn(),
    confirmListForResale: jest.fn(),
    getPriceHistory: jest.fn(),
    updateResalePrice: jest.fn(),
    cancelExpiredListings: jest.fn(),
    buildCancelResaleTx: jest.fn(),
    confirmCancelResale: jest.fn(),
    buildBuyResaleTx: jest.fn(),
    confirmBuyResale: jest.fn(),
  };

  beforeAll(async () => {
    app = await createControllerApp({
      controller: TicketsController,
      service: { provide: TicketsService, useValue: service },
      passthrough: {
        guards: [ScanRateLimitGuard],
        interceptors: [IdempotencyInterceptor],
      },
    });
  });
  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  const http = () => request(server(app));
  const uid = TEST_USER.userId;

  describe('guards and interceptors', () => {
    it('protects every route with JwtAuthGuard at controller level', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        TicketsController,
      ) as unknown[];
      expect(guards).toHaveLength(1);
    });

    it('rate-limits ticket verification scans', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        handlerOf('verify'),
      ) as unknown[];
      expect(guards).toContain(ScanRateLimitGuard);
    });

    it.each([
      'buildIssueTx',
      'buildPurchaseTx',
      'buildTransferTx',
      'buildCheckInTx',
      'buildRevokeTx',
      'buildListForResaleTx',
      'buildCancelResaleTx',
      'buildBuyResaleTx',
    ] as const)('makes %s idempotent', (handler) => {
      const interceptors = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        handlerOf(handler),
      ) as unknown[];
      expect(interceptors).toContain(IdempotencyInterceptor);
    });
  });

  it.each([
    ['get', '/tickets/resale'],
    ['get', '/tickets/mine'],
    ['get', '/tickets/verify/secret'],
    ['get', '/tickets/offline-public-keys'],
    ['get', '/tickets/by-chain/1'],
    ['get', `/tickets/${UUID}`],
    ['get', `/tickets/${UUID}/qr`],
    ['get', `/tickets/${UUID}/qr-token`],
    ['get', `/tickets/${UUID}/offline-token`],
    ['post', '/tickets/issue'],
    ['post', '/tickets/issue-batch'],
    ['post', '/tickets/confirm-issue'],
    ['post', '/tickets/purchase'],
    ['post', '/tickets/confirm-purchase'],
    ['post', `/tickets/${UUID}/transfer`],
    ['post', `/tickets/${UUID}/confirm-transfer`],
    ['post', `/tickets/${UUID}/check-in`],
    ['post', `/tickets/${UUID}/confirm-check-in`],
    ['post', `/tickets/${UUID}/revoke`],
    ['post', `/tickets/${UUID}/confirm-revoke`],
    ['post', '/tickets/events/e1/revoke-batch'],
    ['post', `/tickets/${UUID}/list-resale`],
    ['post', `/tickets/${UUID}/confirm-list-resale`],
    ['get', '/tickets/resale/l1/price-history'],
    ['patch', '/tickets/resale/l1/price'],
    ['post', '/tickets/resale/cancel-expired'],
    ['post', `/tickets/${UUID}/cancel-resale`],
    ['post', `/tickets/${UUID}/confirm-cancel-resale`],
    ['post', `/tickets/${UUID}/buy-resale`],
    ['post', `/tickets/${UUID}/confirm-buy-resale`],
  ] as const)('rejects unauthenticated %s %s', async (method, url) => {
    await http()[method](url).expect(401);
  });

  describe('read routes', () => {
    it('GET /resale forwards cursor and limit, defaulting the limit', async () => {
      service.findActiveResaleListings.mockResolvedValue({ items: [] });
      await http()
        .get('/tickets/resale')
        .query({ cursor: 'c1', limit: 5 })
        .set(AUTH)
        .expect(200);
      expect(service.findActiveResaleListings).toHaveBeenLastCalledWith(
        'c1',
        5,
      );

      await http().get('/tickets/resale').set(AUTH).expect(200);
      expect(service.findActiveResaleListings).toHaveBeenLastCalledWith(
        undefined,
        20,
      );
    });

    it.each([{ limit: 0 }, { limit: 101 }, { limit: 'abc' }])(
      'GET /resale rejects %o',
      async (query) => {
        await http().get('/tickets/resale').query(query).set(AUTH).expect(400);
      },
    );

    it("GET /mine lists the caller's tickets, optionally by status", async () => {
      service.findMine.mockResolvedValue([]);
      await http()
        .get('/tickets/mine')
        .query({ status: 'VALID' })
        .set(AUTH)
        .expect(200);
      expect(service.findMine).toHaveBeenCalledWith(uid, 'VALID');
    });

    it('GET /mine rejects an unknown status', async () => {
      await http()
        .get('/tickets/mine')
        .query({ status: 'EXPIRED' })
        .set(AUTH)
        .expect(400);
      expect(service.findMine).not.toHaveBeenCalled();
    });

    it('GET /verify/:qrSecret verifies as the caller', async () => {
      service.verify.mockResolvedValue({ valid: true });
      await http().get('/tickets/verify/s3cret').set(AUTH).expect(200);
      expect(service.verify).toHaveBeenCalledWith(uid, 's3cret');
    });

    it('GET /offline-public-keys returns the keys', async () => {
      service.getOfflinePublicKeys.mockReturnValue({ keys: {} });
      const res = await http()
        .get('/tickets/offline-public-keys')
        .set(AUTH)
        .expect(200);
      expect(res.body).toEqual({ keys: {} });
    });

    it('GET /by-chain/:id parses the id to a bigint', async () => {
      service.findByChainTicketId.mockResolvedValue({ id: 't' });
      await http()
        .get('/tickets/by-chain/12345678901234567890')
        .set(AUTH)
        .expect(200);
      expect(service.findByChainTicketId).toHaveBeenCalledWith(
        uid,
        12345678901234567890n,
      );
    });

    it('GET /by-chain/:id treats a malformed id as not found without calling the service', async () => {
      const res = await http()
        .get('/tickets/by-chain/not-a-number')
        .set(AUTH)
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Ticket not found',
      );
      expect(service.findByChainTicketId).not.toHaveBeenCalled();
    });

    it.each([
      ['negative', '-1'],
      ['at 2^64', '18446744073709551616'],
    ])(
      'GET /by-chain/:id returns 400 for a %s id without calling the service',
      async (_label, id) => {
        await http().get(`/tickets/by-chain/${id}`).set(AUTH).expect(400);
        expect(service.findByChainTicketId).not.toHaveBeenCalled();
      },
    );

    it('GET /by-chain/:id accepts the largest u64 id', async () => {
      service.findByChainTicketId.mockResolvedValue({ id: 't' });
      await http()
        .get('/tickets/by-chain/18446744073709551615')
        .set(AUTH)
        .expect(200);
      expect(service.findByChainTicketId).toHaveBeenCalledWith(
        uid,
        18446744073709551615n,
      );
    });

    it('GET /:ticketId returns the ticket for the caller (#121)', async () => {
      service.findOne.mockResolvedValue({ id: 't1' });
      const res = await http().get('/tickets/t1').set(AUTH).expect(200);
      expect(res.body).toEqual({ id: 't1' });
      expect(service.findOne).toHaveBeenCalledWith(uid, 't1');
    });

    it('GET /:ticketId propagates 403 and 404 (#121)', async () => {
      service.findOne.mockRejectedValueOnce(new ForbiddenException());
      await http().get('/tickets/t1').set(AUTH).expect(403);

      service.findOne.mockRejectedValueOnce(new NotFoundException());
      await http().get('/tickets/t2').set(AUTH).expect(404);
    });

    it('GET /:ticketId does not shadow the static ticket routes', async () => {
      service.findMine.mockResolvedValue([]);
      service.findActiveResaleListings.mockResolvedValue({ items: [] });
      await http().get('/tickets/mine').set(AUTH).expect(200);
      await http().get('/tickets/resale').set(AUTH).expect(200);
      expect(service.findOne).not.toHaveBeenCalled();
    });

    it('GET /:ticketId/qr serves the PNG uncached (#125)', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      service.getQrImage.mockResolvedValue(png);

      const res = await http().get('/tickets/t1/qr').set(AUTH).expect(200);

      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect((res.body as Buffer).equals(png)).toBe(true);
      expect(service.getQrImage).toHaveBeenCalledWith(uid, 't1');
    });

    it('GET /:ticketId/qr propagates 403 for a non-owner and 404 (#125)', async () => {
      service.getQrImage.mockRejectedValueOnce(new ForbiddenException());
      await http().get('/tickets/t1/qr').set(AUTH).expect(403);

      service.getQrImage.mockRejectedValueOnce(new NotFoundException());
      await http().get('/tickets/t2/qr').set(AUTH).expect(404);
    });

    it('GET /:ticketId/qr-token returns a fresh uncached token (#129)', async () => {
      const issued = {
        token: 'v1.t1.1790592030.sig',
        expiresAt: '2026-10-17T12:00:30.000Z',
        ttlSeconds: 30,
      };
      service.issueQrToken.mockResolvedValue(issued);

      const res = await http()
        .get('/tickets/t1/qr-token')
        .set(AUTH)
        .expect(200);

      expect(res.body).toEqual(issued);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(service.issueQrToken).toHaveBeenCalledWith(uid, 't1');
    });

    it('GET /:ticketId/qr-token propagates 403 for a non-owner (#129)', async () => {
      service.issueQrToken.mockRejectedValueOnce(new ForbiddenException());
      await http().get('/tickets/t1/qr-token').set(AUTH).expect(403);
    });

    it('GET /:ticketId/offline-token propagates not-found', async () => {
      service.getOfflineToken.mockResolvedValueOnce({ token: 't' });
      await http().get('/tickets/t1/offline-token').set(AUTH).expect(200);
      expect(service.getOfflineToken).toHaveBeenCalledWith(uid, 't1');

      service.getOfflineToken.mockRejectedValueOnce(new NotFoundException());
      await http().get('/tickets/t2/offline-token').set(AUTH).expect(404);
    });

    it('GET /resale/:listingId/price-history returns history', async () => {
      service.getPriceHistory.mockResolvedValue([]);
      await http()
        .get('/tickets/resale/l1/price-history')
        .set(AUTH)
        .expect(200);
      expect(service.getPriceHistory).toHaveBeenCalledWith('l1');
    });
  });

  describe('issue', () => {
    const body = {
      ticketTypeId: UUID,
      toUserId: UUID2,
      toPublicKey: KEY,
      seat: 'A1',
    };

    it('POST /issue builds the tx with all fields', async () => {
      service.buildIssueTx.mockResolvedValue({ xdr: 'x' });
      await http().post('/tickets/issue').set(AUTH).send(body).expect(201);
      expect(service.buildIssueTx).toHaveBeenCalledWith(
        uid,
        UUID,
        UUID2,
        KEY,
        'A1',
      );
    });

    it.each([
      ['a non-UUID ticket type', { ticketTypeId: 'x' }],
      ['an invalid wallet', { toPublicKey: 'x' }],
      ['a non-string seat', { seat: 5 }],
    ])('POST /issue rejects %s', async (_l, patch) => {
      await http()
        .post('/tickets/issue')
        .set(AUTH)
        .send({ ...body, ...patch })
        .expect(400);
      expect(service.buildIssueTx).not.toHaveBeenCalled();
    });

    it('POST /confirm-issue forwards fields and signed XDR', async () => {
      service.confirmIssue.mockResolvedValue({ id: 't' });
      await http()
        .post('/tickets/confirm-issue')
        .set(AUTH)
        .send({ ...body, signedXdr: 'AAAA' })
        .expect(201);
      expect(service.confirmIssue).toHaveBeenCalledWith(
        uid,
        UUID,
        UUID2,
        KEY,
        'A1',
        'AAAA',
      );
    });

    it('POST /confirm-issue rejects a missing signedXdr and propagates conflicts', async () => {
      await http()
        .post('/tickets/confirm-issue')
        .set(AUTH)
        .send(body)
        .expect(400);

      service.confirmIssue.mockRejectedValue(
        new ConflictException('Seat taken'),
      );
      const res = await http()
        .post('/tickets/confirm-issue')
        .set(AUTH)
        .send({ ...body, signedXdr: 'AAAA' })
        .expect(409);
      expect((res.body as { message: string }).message).toBe('Seat taken');
    });

    it('POST /confirm-issue returns 409 when the seat is already taken for the event (#135)', async () => {
      service.confirmIssue.mockRejectedValue(
        new ConflictException(
          'That seat has already been issued for this event',
        ),
      );
      const res = await http()
        .post('/tickets/confirm-issue')
        .set(AUTH)
        .send({ ...body, signedXdr: 'sx' })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'That seat has already been issued for this event',
      );
    });
  });

  describe('issue-batch', () => {
    const recipient = { toUserId: UUID2, toPublicKey: KEY };
    const body = { ticketTypeId: UUID, recipients: [recipient] };

    it('POST /issue-batch forwards ticketTypeId and recipients to the service', async () => {
      service.buildIssueBatch.mockResolvedValue({
        total: 1,
        succeeded: 1,
        failed: 0,
        results: [],
      });
      await http()
        .post('/tickets/issue-batch')
        .set(AUTH)
        .send(body)
        .expect(201);
      expect(service.buildIssueBatch).toHaveBeenCalledWith(uid, UUID, [
        recipient,
      ]);
    });

    it('POST /issue-batch rejects a non-UUID ticketTypeId', async () => {
      await http()
        .post('/tickets/issue-batch')
        .set(AUTH)
        .send({ ...body, ticketTypeId: 'not-uuid' })
        .expect(400);
      expect(service.buildIssueBatch).not.toHaveBeenCalled();
    });

    it('POST /issue-batch rejects an empty recipients array', async () => {
      await http()
        .post('/tickets/issue-batch')
        .set(AUTH)
        .send({ ticketTypeId: UUID, recipients: [] })
        .expect(400);
      expect(service.buildIssueBatch).not.toHaveBeenCalled();
    });

    it('POST /issue-batch rejects a recipient with an invalid public key', async () => {
      await http()
        .post('/tickets/issue-batch')
        .set(AUTH)
        .send({
          ticketTypeId: UUID,
          recipients: [{ toUserId: UUID2, toPublicKey: 'bad' }],
        })
        .expect(400);
      expect(service.buildIssueBatch).not.toHaveBeenCalled();
    });

    it('POST /issue-batch returns 400 when the batch exceeds the configured max size', async () => {
      service.buildIssueBatch.mockRejectedValue(
        new BadRequestException(
          'Batch size exceeds the maximum of 50 recipients',
        ),
      );
      const bigBatch = Array.from({ length: 51 }, () => recipient);
      const res = await http()
        .post('/tickets/issue-batch')
        .set(AUTH)
        .send({ ticketTypeId: UUID, recipients: bigBatch })
        .expect(400);
      expect((res.body as { message: string }).message).toContain(
        'Batch size exceeds',
      );
    });
  });

  describe('purchase', () => {
    it('POST /purchase forwards seat and promo code', async () => {
      service.buildPurchaseTx.mockResolvedValue({ xdr: 'x' });
      await http()
        .post('/tickets/purchase')
        .set(AUTH)
        .send({ ticketTypeId: UUID, seat: 'B2', promoCode: 'SAVE10' })
        .expect(201);
      expect(service.buildPurchaseTx).toHaveBeenCalledWith(
        uid,
        UUID,
        'B2',
        'SAVE10',
      );
    });

    it.each([
      ['a non-UUID ticket type', { ticketTypeId: 'x' }],
      ['a too-short promo code', { ticketTypeId: UUID, promoCode: 'ab' }],
    ])('POST /purchase rejects %s', async (_l, body) => {
      await http().post('/tickets/purchase').set(AUTH).send(body).expect(400);
      expect(service.buildPurchaseTx).not.toHaveBeenCalled();
    });

    it('POST /confirm-purchase forwards fields in service argument order', async () => {
      service.confirmPurchase.mockResolvedValue({ id: 't' });
      await http()
        .post('/tickets/confirm-purchase')
        .set(AUTH)
        .send({
          ticketTypeId: UUID,
          seat: 'B2',
          signedXdr: 'AAAA',
          promoCode: 'SAVE10',
        })
        .expect(201);
      expect(service.confirmPurchase).toHaveBeenCalledWith(
        uid,
        UUID,
        'B2',
        'AAAA',
        'SAVE10',
      );
    });

    it('POST /confirm-purchase requires signedXdr', async () => {
      await http()
        .post('/tickets/confirm-purchase')
        .set(AUTH)
        .send({ ticketTypeId: UUID })
        .expect(400);
    });
  });

  describe('transfer', () => {
    const body = { toUserId: UUID2, toPublicKey: KEY };

    it('POST /:ticketId/transfer builds the tx', async () => {
      service.buildTransferTx.mockResolvedValue({ xdr: 'x' });
      await http()
        .post('/tickets/t1/transfer')
        .set(AUTH)
        .send(body)
        .expect(201);
      expect(service.buildTransferTx).toHaveBeenCalledWith(
        uid,
        't1',
        UUID2,
        KEY,
      );
    });

    it('POST /:ticketId/transfer rejects an invalid recipient', async () => {
      await http()
        .post('/tickets/t1/transfer')
        .set(AUTH)
        .send({ ...body, toUserId: 'x' })
        .expect(400);
      await http()
        .post('/tickets/t1/transfer')
        .set(AUTH)
        .send({ ...body, toPublicKey: 'x' })
        .expect(400);
      expect(service.buildTransferTx).not.toHaveBeenCalled();
    });

    it('POST /:ticketId/confirm-transfer forwards fields and propagates errors', async () => {
      service.confirmTransfer.mockResolvedValueOnce({ id: 't1' });
      await http()
        .post('/tickets/t1/confirm-transfer')
        .set(AUTH)
        .send({ ...body, signedXdr: 'AAAA' })
        .expect(201);
      expect(service.confirmTransfer).toHaveBeenCalledWith(
        uid,
        't1',
        UUID2,
        KEY,
        'AAAA',
      );

      service.confirmTransfer.mockRejectedValueOnce(new NotFoundException());
      await http()
        .post('/tickets/t9/confirm-transfer')
        .set(AUTH)
        .send({ ...body, signedXdr: 'AAAA' })
        .expect(404);
    });
  });

  describe('check-in', () => {
    it('POST /:ticketId/check-in builds the tx', async () => {
      service.buildCheckInTx.mockResolvedValue({ xdr: 'x' });
      await http().post('/tickets/t1/check-in').set(AUTH).expect(201);
      expect(service.buildCheckInTx).toHaveBeenCalledWith(uid, 't1');
    });

    it('POST /:ticketId/confirm-check-in forwards gate and reason', async () => {
      service.confirmCheckIn.mockResolvedValue({ ok: true });
      await http()
        .post('/tickets/t1/confirm-check-in')
        .set(AUTH)
        .send({ signedXdr: 'AAAA', gateId: UUID, reason: 'override' })
        .expect(201);
      expect(service.confirmCheckIn).toHaveBeenCalledWith(
        uid,
        't1',
        'AAAA',
        UUID,
        'override',
      );
    });

    it('POST /:ticketId/confirm-check-in rejects a non-UUID gate', async () => {
      await http()
        .post('/tickets/t1/confirm-check-in')
        .set(AUTH)
        .send({ signedXdr: 'AAAA', gateId: 'gate' })
        .expect(400);
      expect(service.confirmCheckIn).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('POST /:ticketId/revoke builds the tx', async () => {
      service.buildRevokeTx.mockResolvedValue({ xdr: 'x' });
      await http().post('/tickets/t1/revoke').set(AUTH).expect(201);
      expect(service.buildRevokeTx).toHaveBeenCalledWith(uid, 't1');
    });

    it('POST /:ticketId/confirm-revoke forwards the signed XDR', async () => {
      service.confirmRevoke.mockResolvedValue({ ok: true });
      await http()
        .post('/tickets/t1/confirm-revoke')
        .set(AUTH)
        .send({ signedXdr: 'AAAA' })
        .expect(201);
      expect(service.confirmRevoke).toHaveBeenCalledWith(uid, 't1', 'AAAA');
    });

    it('POST /:ticketId/confirm-revoke rejects a bad txHash', async () => {
      await http()
        .post('/tickets/t1/confirm-revoke')
        .set(AUTH)
        .send({ signedXdr: 'AAAA', txHash: 'nope' })
        .expect(400);
    });

    it('POST /events/:eventId/revoke-batch forwards ticket ids', async () => {
      service.buildRevokeBatch.mockResolvedValue({
        unsignedXdrs: ['AAAA'],
        chunkSize: 35,
      });
      await http()
        .post('/tickets/events/e1/revoke-batch')
        .set(AUTH)
        .send({ ticketIds: ['a', 'b'] })
        .expect(201);
      expect(service.buildRevokeBatch).toHaveBeenCalledWith(uid, 'e1', [
        'a',
        'b',
      ]);
    });

    it('POST /events/:eventId/confirm-revoke-batch forwards ids and signed XDRs', async () => {
      service.confirmRevokeBatch.mockResolvedValue({ count: 2 });
      await http()
        .post('/tickets/events/e1/confirm-revoke-batch')
        .set(AUTH)
        .send({ ticketIds: ['a', 'b'], signedXdrs: ['AAAA'] })
        .expect(201);
      expect(service.confirmRevokeBatch).toHaveBeenCalledWith(
        uid,
        'e1',
        ['a', 'b'],
        ['AAAA'],
      );
    });

    it.each([
      ['a non-array', { ticketIds: 'a' }],
      ['non-string ids', { ticketIds: [1] }],
      ['an over-long id', { ticketIds: ['x'.repeat(101)] }],
    ])('POST /events/:eventId/revoke-batch rejects %s', async (_l, body) => {
      await http()
        .post('/tickets/events/e1/revoke-batch')
        .set(AUTH)
        .send(body)
        .expect(400);
      expect(service.buildRevokeBatch).not.toHaveBeenCalled();
    });

    it('rejects a confirm-revoke-batch body without signed XDRs', async () => {
      await http()
        .post('/tickets/events/e1/confirm-revoke-batch')
        .set(AUTH)
        .send({ ticketIds: ['a'] })
        .expect(400);
      expect(service.confirmRevokeBatch).not.toHaveBeenCalled();
    });
  });

  describe('resale', () => {
    it('POST /:ticketId/list-resale builds the tx with the price', async () => {
      service.buildListForResaleTx.mockResolvedValue({ xdr: 'x' });
      await http()
        .post('/tickets/t1/list-resale')
        .set(AUTH)
        .send({ price: '5000' })
        .expect(201);
      expect(service.buildListForResaleTx).toHaveBeenCalledWith(
        uid,
        't1',
        '5000',
      );
    });

    it('POST /:ticketId/list-resale rejects a bad price or expiry', async () => {
      await http()
        .post('/tickets/t1/list-resale')
        .set(AUTH)
        .send({ price: 'abc' })
        .expect(400);
      await http()
        .post('/tickets/t1/list-resale')
        .set(AUTH)
        .send({ price: '1', expiresAt: 'tomorrow' })
        .expect(400);
      expect(service.buildListForResaleTx).not.toHaveBeenCalled();
    });

    it('POST /:ticketId/confirm-list-resale forwards price, xdr and expiry', async () => {
      service.confirmListForResale.mockResolvedValue({ id: 'l1' });
      const expiresAt = '2027-01-01T00:00:00.000Z';
      await http()
        .post('/tickets/t1/confirm-list-resale')
        .set(AUTH)
        .send({ price: '5000', signedXdr: 'AAAA', expiresAt })
        .expect(201);
      expect(service.confirmListForResale).toHaveBeenCalledWith(
        uid,
        't1',
        '5000',
        'AAAA',
        expiresAt,
      );
    });

    it('PATCH /resale/:listingId/price updates the price and validates it', async () => {
      service.updateResalePrice.mockResolvedValue({ id: 'l1' });
      await http()
        .patch('/tickets/resale/l1/price')
        .set(AUTH)
        .send({ price: '900' })
        .expect(200);
      expect(service.updateResalePrice).toHaveBeenCalledWith(uid, 'l1', '900');

      await http()
        .patch('/tickets/resale/l1/price')
        .set(AUTH)
        .send({ price: 'x' })
        .expect(400);
    });

    it('POST /resale/cancel-expired triggers cancellation', async () => {
      service.cancelExpiredListings.mockResolvedValue({ cancelled: 3 });
      const res = await http()
        .post('/tickets/resale/cancel-expired')
        .set(AUTH)
        .expect(201);
      expect(res.body).toEqual({ cancelled: 3 });
    });

    it('POST /:ticketId/cancel-resale builds the tx', async () => {
      service.buildCancelResaleTx.mockResolvedValue({ xdr: 'x' });
      await http().post('/tickets/t1/cancel-resale').set(AUTH).expect(201);
      expect(service.buildCancelResaleTx).toHaveBeenCalledWith(uid, 't1');
    });

    it('POST /:ticketId/confirm-cancel-resale forwards the signed XDR', async () => {
      service.confirmCancelResale.mockResolvedValue({ ok: true });
      await http()
        .post('/tickets/t1/confirm-cancel-resale')
        .set(AUTH)
        .send({ signedXdr: HASH })
        .expect(201);
      expect(service.confirmCancelResale).toHaveBeenCalledWith(uid, 't1', HASH);
    });

    it('POST /:ticketId/buy-resale builds the tx', async () => {
      service.buildBuyResaleTx.mockResolvedValue({ xdr: 'x' });
      await http().post('/tickets/t1/buy-resale').set(AUTH).expect(201);
      expect(service.buildBuyResaleTx).toHaveBeenCalledWith(uid, 't1');
    });

    it('POST /:ticketId/confirm-buy-resale forwards the signed XDR and propagates errors', async () => {
      service.confirmBuyResale.mockResolvedValueOnce({ ok: true });
      await http()
        .post('/tickets/t1/confirm-buy-resale')
        .set(AUTH)
        .send({ signedXdr: 'AAAA' })
        .expect(201);
      expect(service.confirmBuyResale).toHaveBeenCalledWith(uid, 't1', 'AAAA');

      service.confirmBuyResale.mockRejectedValueOnce(
        new ConflictException('Already sold'),
      );
      await http()
        .post('/tickets/t1/confirm-buy-resale')
        .set(AUTH)
        .send({ signedXdr: 'AAAA' })
        .expect(409);
    });
  });
});

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  AUTH,
  createControllerApp,
  server,
  TEST_USER,
} from '../../test/helpers/controller-app';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('RefundsController', () => {
  let app: INestApplication;
  const service = {
    create: jest.fn(),
    complete: jest.fn(),
  };

  beforeAll(async () => {
    app = await createControllerApp({
      controller: RefundsController,
      service: { provide: RefundsService, useValue: service },
    });
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.resetAllMocks();
    TEST_USER.role = 'PLATFORM_ADMIN';
  });

  const http = () => request(server(app));

  it.each([
    ['post', '/refunds'],
    ['patch', `/refunds/${VALID_UUID}/complete`],
  ])(
    '%s %s rejects requests without an Authorization header with 401',
    async (method, path) => {
      await http()[method as 'post' | 'patch'](path).expect(401);
    },
  );

  it('POST /refunds rejects non-PLATFORM_ADMIN users with 403', async () => {
    TEST_USER.role = 'ATTENDEE';
    await http()
      .post('/refunds')
      .set(AUTH)
      .send({ ticketId: 't1' })
      .expect(403);
  });

  it('PATCH /refunds/:id/complete rejects non-PLATFORM_ADMIN users with 403', async () => {
    TEST_USER.role = 'ATTENDEE';
    await http().patch(`/refunds/${VALID_UUID}/complete`).set(AUTH).expect(403);
  });

  describe('POST /refunds', () => {
    it('creates a refund for an eligible ticket', async () => {
      service.create.mockResolvedValue({
        id: VALID_UUID,
        ticketId: 't1',
        status: 'PENDING',
      });

      const res = await http()
        .post('/refunds')
        .set(AUTH)
        .send({ ticketId: 't1' })
        .expect(201);

      expect(service.create).toHaveBeenCalledWith('t1');
      expect(res.body).toEqual(expect.objectContaining({ id: VALID_UUID }));
    });
  });

  describe('PATCH /refunds/:id/complete', () => {
    it('returns 400 when :id is not a valid UUID', async () => {
      await http().patch('/refunds/not-a-uuid/complete').set(AUTH).expect(400);

      expect(service.complete).not.toHaveBeenCalled();
    });

    it('completes the refund when :id is a valid UUID', async () => {
      service.complete.mockResolvedValue({
        id: VALID_UUID,
        status: 'COMPLETED',
      });

      const res = await http()
        .patch(`/refunds/${VALID_UUID}/complete`)
        .set(AUTH)
        .expect(200);

      expect(service.complete).toHaveBeenCalledWith(VALID_UUID);
      expect(res.body).toEqual(
        expect.objectContaining({ status: 'COMPLETED' }),
      );
    });
  });
});

import { GoneException, INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  AUTH,
  createControllerApp,
  server,
  TEST_USER,
} from '../../test/helpers/controller-app';
import { EmailVerifiedGuard } from '../auth/guards/email-verified.guard';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

describe('InvitationsController', () => {
  let app: INestApplication;
  const service = { create: jest.fn(), accept: jest.fn() };

  beforeAll(async () => {
    app = await createControllerApp({
      controller: InvitationsController,
      service: { provide: InvitationsService, useValue: service },
      passthrough: { guards: [EmailVerifiedGuard] },
    });
  });
  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  it.each([
    ['/organizations/org-1/invitations'],
    ['/organizations/invitations/accept'],
  ])('rejects unauthenticated POST %s', async (url) => {
    await request(server(app)).post(url).expect(401);
  });

  it('POST /:id/invitations normalizes the email and defaults the role', async () => {
    service.create.mockResolvedValue({
      invitation: { id: 'inv-1' },
      token: 't',
    });
    const res = await request(server(app))
      .post('/organizations/org-1/invitations')
      .set(AUTH)
      .send({ email: '  New@Example.com ' })
      .expect(201);

    expect(service.create).toHaveBeenCalledWith(TEST_USER.userId, 'org-1', {
      email: 'new@example.com',
    });
    expect(res.body).toEqual({ invitation: { id: 'inv-1' }, token: 't' });
  });

  it.each([
    [{ email: 'not-an-email' }],
    [{ email: 'a@example.com', role: 'OWNER' }],
    [{ email: 'a@example.com', extra: true }],
  ])('POST /:id/invitations rejects invalid body %j', async (body) => {
    await request(server(app))
      .post('/organizations/org-1/invitations')
      .set(AUTH)
      .send(body)
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST /invitations/accept passes the token for the current user', async () => {
    service.accept.mockResolvedValue({ id: 'm-1' });
    await request(server(app))
      .post('/organizations/invitations/accept')
      .set(AUTH)
      .send({ token: 'inv_abc' })
      .expect(201);
    expect(service.accept).toHaveBeenCalledWith(TEST_USER.userId, 'inv_abc');
  });

  it('POST /invitations/accept returns 410 for an expired invite', async () => {
    service.accept.mockRejectedValue(
      new GoneException('Invitation has expired'),
    );
    await request(server(app))
      .post('/organizations/invitations/accept')
      .set(AUTH)
      .send({ token: 'inv_abc' })
      .expect(410);
  });

  it('POST /invitations/accept rejects a missing token', async () => {
    await request(server(app))
      .post('/organizations/invitations/accept')
      .set(AUTH)
      .send({})
      .expect(400);
  });
});

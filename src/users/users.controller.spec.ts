import {
  ConflictException,
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
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

const VALID_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const SIGNATURE = 'c2lnbmF0dXJl';

describe('UsersController', () => {
  let app: INestApplication;
  const service = {
    findMe: jest.fn(),
    updateProfile: jest.fn(),
    connectWallet: jest.fn(),
    createStellarChallenge: jest.fn(),
    lookupByEmail: jest.fn(),
  };

  beforeAll(async () => {
    app = await createControllerApp({
      controller: UsersController,
      service: { provide: UsersService, useValue: service },
    });
  });
  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  it.each([
    ['get', '/users/me'],
    ['patch', '/users/me'],
    ['patch', '/users/me/wallet'],
    ['get', '/users/lookup?email=a@b.co'],
  ] as const)('rejects unauthenticated %s %s', async (method, url) => {
    await request(server(app))[method](url).expect(401);
  });

  it("GET /me returns the current user's profile", async () => {
    service.findMe.mockResolvedValue({ id: TEST_USER.userId });
    const res = await request(server(app))
      .get('/users/me')
      .set(AUTH)
      .expect(200);
    expect(res.body).toEqual({ id: TEST_USER.userId });
    expect(service.findMe).toHaveBeenCalledWith(TEST_USER.userId);
  });

  it('GET /me propagates not-found', async () => {
    service.findMe.mockRejectedValue(new NotFoundException('User not found'));
    await request(server(app)).get('/users/me').set(AUTH).expect(404);
  });

  it('PATCH /me trims and updates the current user name', async () => {
    service.updateProfile.mockResolvedValue({
      id: TEST_USER.userId,
      name: 'Ada Lovelace',
    });

    const res = await request(server(app))
      .patch('/users/me')
      .set(AUTH)
      .send({ name: '  Ada Lovelace  ' })
      .expect(200);

    expect((res.body as { name: string }).name).toBe('Ada Lovelace');
    expect(service.updateProfile).toHaveBeenCalledWith(
      TEST_USER.userId,
      'Ada Lovelace',
    );
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name over 256 characters', { name: 'a'.repeat(257) }],
    ['a missing name', {}],
    ['an unknown field', { name: 'Ada', email: 'new@example.com' }],
  ])('PATCH /me rejects %s', async (_label, body) => {
    await request(server(app))
      .patch('/users/me')
      .set(AUTH)
      .send(body)
      .expect(400);
    expect(service.updateProfile).not.toHaveBeenCalled();
  });

  it('PATCH /me/wallet connects a valid wallet', async () => {
    service.connectWallet.mockResolvedValue({
      id: TEST_USER.userId,
      stellarPublicKey: VALID_KEY,
    });
    await request(server(app))
      .patch('/users/me/wallet')
      .set(AUTH)
      .send({ stellarPublicKey: VALID_KEY, signature: SIGNATURE })
      .expect(200);
    expect(service.connectWallet).toHaveBeenCalledWith(
      TEST_USER.userId,
      VALID_KEY,
      SIGNATURE,
    );
  });

  it.each([
    ['an invalid key', { stellarPublicKey: 'not-a-key' }],
    ['a missing key', {}],
    ['an unknown field', { stellarPublicKey: VALID_KEY, extra: 1 }],
    ['a missing signature', { stellarPublicKey: VALID_KEY }],
  ])('PATCH /me/wallet rejects %s', async (_label, body) => {
    await request(server(app))
      .patch('/users/me/wallet')
      .set(AUTH)
      .send(body)
      .expect(400);
    expect(service.connectWallet).not.toHaveBeenCalled();
  });

  it('POST /me/stellar-challenge issues a challenge for the signed-in user (#596)', async () => {
    service.createStellarChallenge.mockResolvedValue({ message: 'm' });
    await request(server(app))
      .post('/users/me/stellar-challenge')
      .set(AUTH)
      .send({ stellarPublicKey: VALID_KEY, purpose: 'wallet-connect' })
      .expect(201);
    expect(service.createStellarChallenge).toHaveBeenCalledWith(
      TEST_USER.userId,
      { stellarPublicKey: VALID_KEY, purpose: 'wallet-connect' },
    );
  });

  it('POST /me/stellar-challenge rejects an unknown purpose', async () => {
    await request(server(app))
      .post('/users/me/stellar-challenge')
      .set(AUTH)
      .send({ stellarPublicKey: VALID_KEY, purpose: 'something-else' })
      .expect(400);
    expect(service.createStellarChallenge).not.toHaveBeenCalled();
  });

  it('PATCH /me/wallet propagates a wallet conflict', async () => {
    service.connectWallet.mockRejectedValue(
      new ConflictException('Wallet already linked'),
    );
    const res = await request(server(app))
      .patch('/users/me/wallet')
      .set(AUTH)
      .send({ stellarPublicKey: VALID_KEY, signature: SIGNATURE })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Wallet already linked',
    );
  });

  it('GET /lookup finds a user by email', async () => {
    service.lookupByEmail.mockResolvedValue({ id: 'u2' });
    await request(server(app))
      .get('/users/lookup')
      .query({ email: 'a@b.co' })
      .set(AUTH)
      .expect(200);
    expect(service.lookupByEmail).toHaveBeenCalledWith('a@b.co');
  });

  it('GET /lookup rejects an invalid email and propagates not-found', async () => {
    await request(server(app))
      .get('/users/lookup')
      .query({ email: 'nope' })
      .set(AUTH)
      .expect(400);
    expect(service.lookupByEmail).not.toHaveBeenCalled();

    service.lookupByEmail.mockRejectedValue(new NotFoundException());
    await request(server(app))
      .get('/users/lookup')
      .query({ email: 'a@b.co' })
      .set(AUTH)
      .expect(404);
  });
});

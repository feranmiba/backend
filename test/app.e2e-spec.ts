import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from './../src/app.module';
import { AuthModule } from '../src/auth/auth.module';
import { UsersModule } from '../src/users/users.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Requires a real DATABASE_URL (and the rest of .env.example) — PrismaService
// connects on module init, so this is a genuine end-to-end check. Runs in CI
// via the `e2e-test` job, which provisions a Postgres service container (see
// .github/workflows/ci.yml).
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    await app.init();
  });

  it('/v1/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/v1/health')
      .expect(200)
      .expect({ status: 'ok', service: 'stellar-tickets-backend' });
  });

  afterEach(async () => {
    await app.close();
  });
});
if (await this.findProcessedTx<null>(signedXdr)) return;
if (ticket.status !== TicketStatus.RESALE) {
  throw new ListingInactiveError();
}

/**
 * Auth flow (#409): register, login, GET /users/me, and a request without a
 * token.
 *
 * This boots only AuthModule + UsersModule + PrismaModule + ConfigModule
 * rather than the full AppModule — the full app also constructs
 * StellarService, which validates PLATFORM_SIGNER_SECRET as a real,
 * checksummed Stellar secret key (via `Keypair.fromSecret`) and
 * TICKETING_CONTRACT_ID as a real contract address at module-init time, and
 * provisioning valid values for those has nothing to do with the auth flow
 * this issue asks to cover. The existing `AppController (e2e)` suite above
 * already exercises the full `AppModule` boot path for the health check.
 */
describe('Auth flow (e2e) (#409)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const testEmail = `auth-e2e-${randomUUID()}@example.com`;
  const testPassword = 'a-reasonably-long-password';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        UsersModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await app.close();
  });

  it('rejects GET /users/me without a token', () => {
    return request(app.getHttpServer()).get('/v1/users/me').expect(401);
  });

  it('registers a new account', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: testEmail, password: testPassword, name: 'Auth E2E' })
      .expect(201);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user).toMatchObject({ email: testEmail, name: 'Auth E2E' });
  });

  it('rejects registering the same email twice', () => {
    return request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: testEmail, password: testPassword, name: 'Auth E2E' })
      .expect(409);
  });

  it('logs in with the registered credentials and can fetch /users/me', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: testEmail, password: testPassword })
      .expect(200);

    const { accessToken } = loginRes.body;
    expect(accessToken).toBeDefined();

    const meRes = await request(app.getHttpServer())
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(meRes.body).toMatchObject({ email: testEmail, name: 'Auth E2E' });
  });

  it('rejects login with the wrong password', () => {
    return request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: testEmail, password: 'definitely-the-wrong-password' })
      .expect(401);
  });

  it('rejects GET /users/me with a malformed bearer token', () => {
    return request(app.getHttpServer())
      .get('/v1/users/me')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
  });
});

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthService } from './auth.service';
import { JWT_SIGNING_SECRET, JwtSecretModule } from './jwt-secret.module';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    NotificationsModule,
    JwtSecretModule,
    JwtModule.registerAsync({
      imports: [JwtSecretModule],
      inject: [JWT_SIGNING_SECRET],
      useFactory: (secret: string) => ({
        secret,
        signOptions: { expiresIn: '1h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}

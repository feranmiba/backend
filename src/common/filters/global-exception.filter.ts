import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DomainError } from '../errors/domain.error';

const PRISMA_CODE_TO_STATUS: Readonly<Record<string, number>> = {
  P2002: HttpStatus.CONFLICT,
  P2025: HttpStatus.NOT_FOUND,
};

const DOMAIN_CODE_TO_STATUS: Readonly<Record<string, number>> = {
  LISTING_INACTIVE: HttpStatus.BAD_REQUEST,
  TICKET_TYPE_SOLD_OUT: HttpStatus.CONFLICT,
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const rawRequestId =
      request?.headers?.['x-request-id'] ??
      (request as unknown as { id?: string })?.id ??
      (response?.getHeader?.('x-request-id') as string | undefined);
    const requestId =
      typeof rawRequestId === 'string'
        ? rawRequestId
        : Array.isArray(rawRequestId)
          ? rawRequestId[0]
          : undefined;

    // HttpExceptions (404s, 403s, ValidationPipe 400s, ...) already carry
    // their status and body. Forward them unchanged so clients keep Nest's
    // `{ statusCode, message, error }` shape instead of a generic 500.
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const body = exception.getResponse();
      let responseBody: Record<string, unknown>;
      if (typeof body === 'string') {
        responseBody = { statusCode, message: body };
      } else if (typeof body === 'object' && body !== null) {
        responseBody = { ...(body as Record<string, unknown>) };
      } else {
        responseBody = { statusCode, message: String(body) };
      }
      if (requestId && responseBody.requestId === undefined) {
        responseBody.requestId = requestId;
      }
      response.status(statusCode).json(responseBody);
      return;
    }

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      statusCode =
        PRISMA_CODE_TO_STATUS[exception.code] ??
        HttpStatus.INTERNAL_SERVER_ERROR;
      code = `PRISMA_${exception.code}`;
      message = this.getPrismaErrorMessage(exception);
    } else if (exception instanceof DomainError) {
      statusCode =
        DOMAIN_CODE_TO_STATUS[exception.code] ??
        HttpStatus.INTERNAL_SERVER_ERROR;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      statusCode = HttpStatus.BAD_REQUEST;
      code = 'PRISMA_VALIDATION_ERROR';
      message = 'Invalid data provided';
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'PRISMA_INITIALIZATION_ERROR';
      message = 'Database connection failed';
    } else if (exception instanceof Error) {
      const prefix = requestId ? `[${requestId}] ` : '';
      this.logger.error(
        `${prefix}Unhandled exception: ${exception.message}`,
        exception.stack,
        `${request.method} ${request.url}`,
      );
    }

    const responseBody = {
      statusCode,
      code,
      message,
      ...(code === 'INTERNAL_ERROR' && {
        error: 'Internal Server Error',
        requestId: requestId ?? randomUUID(),
      }),
    };
    response.status(statusCode).json(responseBody);
  }

  private getPrismaErrorMessage(
    error: Prisma.PrismaClientKnownRequestError,
  ): string {
    switch (error.code) {
      case 'P2002':
        return 'A record with this value already exists';
      case 'P2025':
        return 'Record not found';
      default:
        return 'Database operation failed';
    }
  }
}

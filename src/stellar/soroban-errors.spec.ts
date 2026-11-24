import { BadRequestException, HttpStatus } from '@nestjs/common';
import { Error as ContractError } from './generated/ticketing/types';
import {
  SOROBAN_ERROR_MAP,
  mapSorobanErrorToApiException,
  parseSorobanErrorCode,
} from './soroban-errors';

describe('Soroban contract error mapping (#498)', () => {
  const contractCodes = Object.keys(ContractError).map(Number);

  it('maps every generated contract error code', () => {
    expect(contractCodes).toHaveLength(93);
    for (const code of contractCodes) {
      const mapping = SOROBAN_ERROR_MAP[code];
      expect(typeof mapping.status).toBe('number');
      expect(typeof mapping.message).toBe('string');
      expect(mapping.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it.each([
    ['Error(Contract, #9)', 9],
    ['contract error #51', 51],
    ['ContractError(98)', 98],
    ['unrelated rpc failure', null],
  ])('parses %s as code %s', (message, expected) => {
    expect(parseSorobanErrorCode(message)).toBe(expected);
  });

  it('returns the mapped HTTP status, human message, and stable code', () => {
    const exception = mapSorobanErrorToApiException(
      'HostError: Error(Contract, #9)',
    );

    expect(exception.getStatus()).toBe(HttpStatus.GONE);
    expect(exception.getResponse()).toEqual({
      statusCode: HttpStatus.GONE,
      message: 'The ticket has been revoked',
      error: 'REVOKED',
    });
  });

  it('uses a safe 400 fallback for unmapped errors', () => {
    const exception = mapSorobanErrorToApiException('rpc unavailable');
    expect(exception).toBeInstanceOf(BadRequestException);
    expect(exception.getResponse()).toMatchObject({
      message: 'Soroban contract error: rpc unavailable',
    });
  });
});

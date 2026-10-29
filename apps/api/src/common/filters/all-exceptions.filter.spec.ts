import { ConflictException, ForbiddenException, HttpStatus, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AllExceptionsFilter, isMalformedIdentifier } from './all-exceptions.filter';

function run(exception: unknown) {
  const json = jest.fn();
  const response: any = { status: jest.fn().mockReturnValue({ json }) };
  const host: any = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ method: 'GET', url: '/v1/partner/events/x' }) }) };
  new AllExceptionsFilter().catch(exception, host);
  return { status: response.status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('AllExceptionsFilter', () => {
  it('un conflicto lleva el código CONFLICT y no INTERNAL_ERROR', () => {
    const { status, body } = run(new ConflictException('Idempotency-Key ya fue utilizada con otra solicitud'));
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('un servicio no disponible responde 503 con su propio código', () => {
    const { status, body } = run(new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE', message: 'caído' }));
    expect(status).toBe(503);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('un id que no es UUID responde 400 y no 500', () => {
    const prismaLike = Object.assign(new Error('Error creating UUID, invalid character'), { name: 'PrismaClientKnownRequestError', code: 'P2023' });
    expect(isMalformedIdentifier(prismaLike)).toBe(true);
    const { status, body } = run(prismaLike);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('un error inesperado sigue siendo 500 y no filtra el detalle', () => {
    const { status, body } = run(new Error('boom con datos internos'));
    expect(status).toBe(500);
    expect(body.error.message).toBe('Error interno del servidor');
  });

  it('los datos extra de un tope del contrato llegan en details', () => {
    const { status, body } = run(new ForbiddenException({ code: 'EVENT_LIMIT_REACHED', message: 'Tope', limit: 3, used: 3, resetsAt: '2027-01-01T00:00:00.000Z' }));
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: 'EVENT_LIMIT_REACHED', message: 'Tope', details: { limit: 3, used: 3, resetsAt: '2027-01-01T00:00:00.000Z' } });
  });

  it('conserva el código explícito de la excepción', () => {
    const { body } = run(new NotFoundException({ code: 'EVENT_GONE', message: 'x' }));
    expect(body.error.code).toBe('EVENT_GONE');
  });
});

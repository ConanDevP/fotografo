import { UserThrottlerGuard } from './user-throttler.guard';

// getTracker es protegido: se prueba a través de una subclase mínima.
class Probe extends UserThrottlerGuard {
  track(req: Record<string, any>) { return this.getTracker(req); }
}
const probe = new Probe({} as any, {} as any, {} as any);
const PREFIX = 'a1b2c3d4e5f60718';

describe('UserThrottlerGuard.getTracker', () => {
  it('identifica por usuario cuando hay sesión', () => {
    expect(probe.track({ user: { id: 'u1' }, ip: '1.1.1.1' })).toBe('user:u1');
  });

  it('identifica una clave de producción por su prefijo público', () => {
    expect(probe.track({ headers: { authorization: `Bearer lm_live_${PREFIX}_secreto` }, ip: '1.1.1.1' })).toBe(`api:${PREFIX}`);
  });

  it('identifica también las claves de prueba (lm_test_) y no las manda al cupo por IP', () => {
    expect(probe.track({ headers: { authorization: `Bearer lm_test_${PREFIX}_secreto` }, ip: '1.1.1.1' })).toBe(`api:${PREFIX}`);
    expect(probe.track({ headers: { 'x-api-key': `lm_test_${PREFIX}_secreto` }, ip: '1.1.1.1' })).toBe(`api:${PREFIX}`);
  });

  it('sin credencial usa la IP', () => {
    expect(probe.track({ headers: {}, ip: '9.9.9.9' })).toBe('ip:9.9.9.9');
  });
});

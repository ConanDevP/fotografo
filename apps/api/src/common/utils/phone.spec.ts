import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('acepta un número internacional con prefijo', () => {
    expect(normalizePhone('+52 55 1234 5678')).toEqual({ e164: '+525512345678', country: 'MX' });
  });

  it('completa con el país cuando el número es nacional', () => {
    expect(normalizePhone('(415) 555-2671', 'US')).toEqual({ e164: '+14155552671', country: 'US' });
    expect(normalizePhone('11 91234-5678', 'br')).toEqual({ e164: '+5511912345678', country: 'BR' });
  });

  it('rechaza lo que no es un número real', () => {
    expect(normalizePhone('12345', 'US')).toBeNull();
    expect(normalizePhone('hola')).toBeNull();
    expect(normalizePhone('5512345678')).toBeNull(); // sin país ni prefijo
  });

  it('ignora un país inexistente en vez de fallar', () => {
    expect(normalizePhone('+34 612 34 56 78', 'ZZ')?.country).toBe('ES');
  });
});

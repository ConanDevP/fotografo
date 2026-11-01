import { digestJobId, DIGEST_WINDOW_MS, signUnsubscribeToken, verifyUnsubscribeToken } from './registration';

const ID = '6f1c1d0e-2b7a-4c53-9a53-0d1f8c9e7a11';

describe('enlace de baja', () => {
  it('se verifica con el mismo secreto', () => {
    const token = signUnsubscribeToken(ID, 'secreto-uno');
    expect(verifyUnsubscribeToken(token, 'secreto-uno')).toBe(ID);
  });

  it('no sirve con otro secreto ni con una firma alterada', () => {
    const token = signUnsubscribeToken(ID, 'secreto-uno');
    expect(verifyUnsubscribeToken(token, 'secreto-dos')).toBeNull();
    expect(verifyUnsubscribeToken(`${token}x`, 'secreto-uno')).toBeNull();
    expect(verifyUnsubscribeToken(token.slice(0, -2), 'secreto-uno')).toBeNull();
  });

  it('no deja dar de baja a otro cambiando el id', () => {
    const token = signUnsubscribeToken(ID, 'secreto-uno');
    const otro = '11111111-2222-4333-8444-555555555555';
    expect(verifyUnsubscribeToken(`${otro}.${token.split('.')[1]}`, 'secreto-uno')).toBeNull();
  });

  it('rechaza basura', () => {
    expect(verifyUnsubscribeToken('', 's')).toBeNull();
    expect(verifyUnsubscribeToken('sin-punto', 's')).toBeNull();
    expect(verifyUnsubscribeToken('no-es-uuid.firma', 's')).toBeNull();
  });
});

describe('digestJobId', () => {
  it('agrupa lo que cae en la misma ventana y separa la siguiente', () => {
    const start = 1_700_000_000_000 - ((1_700_000_000_000) % DIGEST_WINDOW_MS);
    expect(digestJobId(ID, start + 1000)).toBe(digestJobId(ID, start + DIGEST_WINDOW_MS - 1));
    expect(digestJobId(ID, start)).not.toBe(digestJobId(ID, start + DIGEST_WINDOW_MS));
  });

  it('no usa ":" que BullMQ prohíbe en los ids', () => {
    expect(digestJobId(ID)).not.toContain(':');
  });
});

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Cifra las credenciales que el cliente nos confía (clave de Resend, token de
 * WhatsApp). AES-256-GCM con la misma llave que protege los secretos de los
 * webhooks: si alguien lee la base de datos, no obtiene credenciales usables.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string | undefined, production: boolean) {
    if (!secret && production) throw new Error('PARTNER_WEBHOOK_ENCRYPTION_KEY no está configurado');
    this.key = createHash('sha256').update(secret || 'development-only-webhook-key').digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(value: string): string {
    const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  /** Últimos 4 caracteres, para reconocer la credencial sin revelarla. */
  static hint(value: string): string {
    return value.length > 8 ? `…${value.slice(-4)}` : '…';
  }
}

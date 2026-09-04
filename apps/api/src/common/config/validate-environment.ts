export function normalizePem(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '';
}

export function validateEnvironment(config: Record<string, unknown>) {
  if (config.NODE_ENV !== 'production') return config;

  const errors: string[] = [];
  const text = (name: string) => typeof config[name] === 'string' ? String(config[name]).trim() : '';
  const requireValue = (name: string) => {
    const value = text(name);
    if (!value || /replace-with|changeme|example/i.test(value)) errors.push(`${name} no está configurado`);
    return value;
  };
  const requireSecret = (name: string, minLength = 32) => {
    const value = requireValue(name);
    if (value && value.length < minLength) errors.push(`${name} debe tener al menos ${minLength} caracteres`);
    return value;
  };
  const requireUrl = (name: string, protocols: string[]) => {
    const value = requireValue(name);
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol)) errors.push(`${name} debe usar ${protocols.join(' o ')}`);
    } catch {
      errors.push(`${name} no es una URL válida`);
    }
  };

  requireUrl('DATABASE_URL', ['postgres:', 'postgresql:']);
  requireUrl('REDIS_URL', ['redis:', 'rediss:']);
  requireUrl('FRONTEND_URL', ['https:']);
  requireUrl('API_URL', ['https:']);
  // Base de los enlaces que van por correo (recuperar contraseña, etc.). Sin
  // este chequeo, faltar la variable no rompe el arranque: solo manda enlaces
  // a localhost en silencio, y nadie lo nota hasta que un cliente real se
  // queda sin poder entrar.
  requireUrl('APP_URL', ['https:']);
  requireValue('EMAIL_FROM');
  requireValue('RESEND_API_KEY');
  requireSecret('ORDER_ACCESS_SECRET');
  requireSecret('METRICS_HASH_SECRET');
  requireSecret('FACE_API_KEY');
  requireSecret('PARTNER_WEBHOOK_ENCRYPTION_KEY');
  requireValue('GEMINI_API_KEY');

  const privateKey = normalizePem(config.JWT_PRIVATE_KEY);
  const publicKey = normalizePem(config.JWT_PUBLIC_KEY);
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(privateKey)) errors.push('JWT_PRIVATE_KEY debe ser una clave privada PEM');
  if (!/BEGIN (?:RSA )?PUBLIC KEY/.test(publicKey)) errors.push('JWT_PUBLIC_KEY debe ser una clave pública PEM');
  config.JWT_PRIVATE_KEY = privateKey;
  config.JWT_PUBLIC_KEY = publicKey;

  const origins = text('CORS_ORIGINS').split(',').map(item => item.trim()).filter(Boolean);
  if (origins.length === 0) errors.push('CORS_ORIGINS no está configurado');
  origins.forEach(origin => {
    try {
      if (new URL(origin).protocol !== 'https:') errors.push(`CORS_ORIGINS contiene un origen no HTTPS: ${origin}`);
    } catch {
      errors.push(`CORS_ORIGINS contiene un origen inválido: ${origin}`);
    }
  });

  if (text('DEMO_PAYMENTS') === 'true') errors.push('DEMO_PAYMENTS no puede estar activo en producción');
  if (text('STRIPE_SECRET_KEY') && !text('STRIPE_WEBHOOK_SECRET')) {
    errors.push('STRIPE_WEBHOOK_SECRET es obligatorio cuando Stripe está activo');
  }
  if (text('ADMIN_SECRET_KEY') && text('ADMIN_SECRET_KEY').length < 32) {
    errors.push('ADMIN_SECRET_KEY debe tener al menos 32 caracteres');
  }

  const storage = text('STORAGE_PROVIDER') || 'cloudinary';
  if (!['cloudinary', 'r2'].includes(storage)) errors.push('STORAGE_PROVIDER debe ser cloudinary o r2');
  const storageKeys = storage === 'r2'
    ? ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_BUCKET_NAME', 'R2_PUBLIC_URL']
    : ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  storageKeys.forEach(requireValue);
  if (storage === 'r2') requireUrl('R2_PUBLIC_URL', ['https:']);
  if (storage === 'r2' && text('R2_BUCKET_NAME') === text('R2_PUBLIC_BUCKET_NAME')) {
    errors.push('R2_BUCKET_NAME y R2_PUBLIC_BUCKET_NAME deben ser distintos');
  }

  if (errors.length) throw new Error(`Configuración de producción inválida:\n- ${errors.join('\n- ')}`);
  return config;
}

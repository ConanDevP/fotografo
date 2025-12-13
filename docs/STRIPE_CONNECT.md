# Stripe Connect - Guía de Implementación

## Resumen

Stripe Connect permite que los fotógrafos reciban pagos directamente en sus cuentas de Stripe, mientras la plataforma cobra una comisión automáticamente.

## Arquitectura

```
Cliente → Stripe Checkout → Stripe Connect → Fotógrafo (menos comisión)
                                          → Plataforma (comisión)
```

## Configuración

### 1. Variables de Entorno

```bash
# En .env del API
STRIPE_SECRET_KEY=sk_test_xxx          # Tu secret key de Stripe
STRIPE_PUBLISHABLE_KEY=pk_test_xxx     # Tu publishable key
STRIPE_WEBHOOK_SECRET=whsec_xxx        # Para verificar webhooks
```

### 2. Obtener Keys de Stripe

1. Ve a https://dashboard.stripe.com/apikeys
2. Copia la **Secret key** (sk_test_xxx para sandbox, sk_live_xxx para producción)
3. Copia la **Publishable key** (pk_test_xxx o pk_live_xxx)

### 3. Configurar Webhooks

1. Ve a https://dashboard.stripe.com/webhooks
2. Añade un endpoint: `https://tu-api.com/v1/webhooks/stripe`
3. Selecciona estos eventos:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `account.updated`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
4. Copia el **Signing secret** (whsec_xxx) a `STRIPE_WEBHOOK_SECRET`

## Flujo de Onboarding de Fotógrafos

### 1. Iniciar Onboarding

```bash
POST /v1/photographers/stripe/onboarding/start
Authorization: Bearer {token}
```

Respuesta:
```json
{
  "data": {
    "accountId": "acct_xxx",
    "onboardingUrl": "https://connect.stripe.com/setup/...",
    "message": "Redirige al fotógrafo a esta URL"
  }
}
```

### 2. Callback después del Onboarding

El fotógrafo es redirigido a:
```
/dashboard/photographer/stripe/callback?accountId=xxx&chargesEnabled=true
```

### 3. Verificar Estado

```bash
GET /v1/photographers/stripe/status
Authorization: Bearer {token}
```

Respuesta:
```json
{
  "data": {
    "connected": true,
    "accountId": "acct_xxx",
    "chargesEnabled": true,
    "payoutsEnabled": true,
    "readyToReceivePayments": true
  }
}
```

## Flujo de Pagos

### 1. Crear Orden con Stripe

```bash
POST /v1/payments/orders
{
  "eventId": "uuid",
  "gateway": "stripe",
  "items": [
    { "type": "PHOTO", "photoId": "uuid" }
  ]
}
```

### 2. Redirect a Stripe Checkout

El cliente es redirigido a Stripe Checkout donde ingresa su tarjeta.

### 3. Confirmación

Después del pago, el cliente es redirigido a:
```
/payment/success?session_id=cs_xxx
```

## Comisiones

La comisión de la plataforma se configura por evento:

```prisma
model Event {
  platformFeePercent Decimal @default(15.0)
}
```

Stripe automáticamente:
1. Cobra al cliente el total
2. Transfiere al fotógrafo (total - comisión)
3. La comisión queda en la cuenta de la plataforma

## Endpoints del API

### Onboarding
- `POST /v1/photographers/stripe/onboarding/start` - Iniciar onboarding
- `GET /v1/photographers/stripe/callback` - Callback de Stripe
- `GET /v1/photographers/stripe/refresh` - Refrescar link expirado
- `GET /v1/photographers/stripe/status` - Estado de conexión
- `POST /v1/photographers/stripe/refresh-status` - Actualizar estado desde Stripe
- `GET /v1/photographers/stripe/dashboard` - Link al dashboard de Stripe
- `GET /v1/photographers/stripe/balance` - Balance de la cuenta

### Webhooks
- `POST /v1/webhooks/stripe` - Recibir eventos de Stripe

## Modelo de Datos

```prisma
model User {
  // Stripe Connect
  stripeAccountId           String?   @unique
  stripeAccountStatus       String?   // pending, active, restricted
  stripeOnboardingCompleted Boolean   @default(false)
  stripeChargesEnabled      Boolean   @default(false)
  stripePayoutsEnabled      Boolean   @default(false)
  stripeOnboardedAt         DateTime?
}
```

## Testing

### Tarjetas de Prueba

- **Éxito**: 4242 4242 4242 4242
- **Requiere autenticación**: 4000 0025 0000 3155
- **Declinada**: 4000 0000 0000 9995

### Cuentas de Prueba para Connect

En modo test, puedes completar el onboarding con datos ficticios.

## Migración desde PayPal

1. Los fotógrafos existentes mantienen su conexión PayPal
2. Pueden conectar Stripe adicionalmente
3. El frontend muestra ambas opciones de pago
4. PayPal sigue funcionando en modo básico (sin marketplace)

## Troubleshooting

### "Stripe not configured"
- Verifica que `STRIPE_SECRET_KEY` esté en `.env`

### "Webhook signature verification failed"
- Verifica que `STRIPE_WEBHOOK_SECRET` sea correcto
- Asegúrate de usar el raw body para verificación

### "Photographer hasn't completed Stripe onboarding"
- El fotógrafo debe completar el onboarding en Stripe
- Verifica `stripeChargesEnabled` y `stripePayoutsEnabled`

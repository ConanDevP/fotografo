# Pagos: cómo funcionan con la API

Hay tres formas de cobrar a quien compra las fotografías. Elige una **por evento**. Lo que cambia es quién procesa el pago, quién ve
la venta y qué te cobramos nosotros.

| | A. Tu checkout y tu pasarela | B. Nuestro checkout (tienda con tu marca) | C. Descarga gratuita con patrocinadores |
|---|---|---|---|
| Quién cobra al comprador | Tú, con tu pasarela | LucilaMon, con Stripe o PayPal | Nadie: el corredor descarga gratis |
| Quién ve el pago | Solo tú | Tú en el panel; LucilaMon en su libro contable | No hay pago |
| Qué nos pagas | Solo el contrato (cuota anual y, si lo permite, exceso de fotografías) | Contrato + la comisión de tu plan sobre cada venta | Solo el contrato |
| Cómo entregas la foto | `POST /photos/{photoId}/download-url` cuando tu pago esté confirmado | El comprador la descarga desde nuestra tienda | `POST /events/{eventId}/photos/{photoId}/download-free` |
| Modo del evento (`commerceMode`) | No importa; mantén el evento **sin publicar** | `PAID` y publicado, con `pricing` | `FREE` y publicado |

## A. Tu checkout y tu pasarela

Es el modelo pensado para cronometradores y plataformas que ya tienen inscripción y pago.

1. Sube y procesa las fotografías por la API.
2. Muestra a tus clientes las vistas con marca de agua (`/photos/{photoId}/assets`) y las búsquedas por dorsal o selfie
   (`/events/{eventId}/search/...`). Estas búsquedas **funcionan con el evento sin publicar**: no hace falta abrir la galería pública de LucilaMon.
3. Cobra con tu pasarela. LucilaMon no ve el pedido, ni el comprador, ni el importe.
4. Cuando el pago esté confirmado en **tu backend**, pide el enlace al original con `POST /photos/{photoId}/download-url`
   (o `/photos/bulk/download-urls` para varias). El enlace caduca en 60–900 segundos: entrégalo en el momento y no lo guardes.

La autorización comercial de cada descarga es tuya: la API entrega el archivo a quien tu servidor le pida. Por eso `photos:download` solo
debe vivir en tu backend. Tu contrato debe incluir las descargas de originales.

`pricing` y `commerceMode` solo los usa nuestra tienda. Si cobras tú, puedes dejarlos con valores cualquiera; lo que importa es no publicar el evento.

## B. Nuestro checkout

Si publicas el evento en modo `PAID`, el comprador paga en tu tienda de LucilaMon (tu marca y, con el plan adecuado, tu dominio) con **Stripe o PayPal**.
Cada venta se reparte en el libro contable de la plataforma:

- **Venta bruta** del pedido.
- **Comisión de la pasarela** (Stripe o PayPal), que se descuenta de la venta.
- **Comisión de LucilaMon**: el porcentaje del plan del beneficiario (con contrato Enterprise se aplica como mínimo el del plan Business, 6 %).
- **Comisión del organizador**, si hay fotógrafos invitados con reparto pactado.
- **Ganancia del fotógrafo**: lo que queda.

El dinero llega a la cuenta de cobro que cada fotógrafo u organizador conecta **desde el panel** (Stripe Connect o PayPal). Esa conexión no se puede hacer por la API.

**Qué ves por la API** (permiso `orders:read`):

- `GET /orders` y `GET /orders/{orderId}`: los pedidos pagados en tu tienda de LucilaMon, con el correo del comprador, las partidas y el desglose de la venta
  (bruto, comisión de la pasarela, comisión de LucilaMon, comisión del organizador, ganancia del fotógrafo, y lo que te corresponde a ti y cómo va su cobro).
- `GET /earnings`: lo transferido a tu cuenta, lo pendiente, lo revertido por reembolsos o contracargos, y los últimos asientos del libro contable.
- Webhooks `order.paid`, `order.refunded`, `order.disputed` y `order.dispute.closed`, con el mismo objeto de pedido.

**Qué sigue sin estar en la API:** conectar la cuenta de cobro (Stripe Connect o PayPal), que se hace **desde el panel**, y los reembolsos, que gestiona el equipo de
LucilaMon: escríbenos con el pedido. Los pagos hechos en tu propia pasarela (modelo A) no aparecen aquí porque no pasan por nosotros.

Si muestras las fotografías en tu propia tienda, envía las visitas y búsquedas de tus clientes con `POST /events/{eventId}/metrics` (permiso `metrics:write`): así el embudo y
los informes del evento tienen datos aunque nadie pase por la tienda de LucilaMon.

## C. Descarga gratuita con patrocinadores

En modo `FREE` el corredor descarga sin pagar. Los logos de los patrocinadores que asignes al evento se imprimen en la imagen (`sponsorOverlayEnabled` y
`requiredOnFreeDownloads`). El cobro a tus patrocinadores es cosa tuya: LucilaMon no interviene. Con un contrato Enterprise (o piloto) **no se cobra por
fotografía subida ni se exige tarjeta** para publicar: las fotografías ya cuentan contra el cupo anual del contrato.

## Lo que te facturamos a ti

El contrato se factura por Stripe (factura enviada, a pagar por tarjeta, ACH o transferencia con el plazo acordado):

- **Cuota anual**, al empezar cada año contractual.
- **Exceso de fotografías**, cada mes vencido, solo si el contrato lo permite y fija un precio por fotografía. Si no lo permite, la subida que superaría el cupo se rechaza con `PHOTO_LIMIT_REACHED`.

Consulta el consumo con `GET /usage`. Recibes aviso al 80 % y al 100 % de cada tope (correo y webhook `usage.threshold`).

## Recomendación según tu caso

- **Cronometrador o plataforma con su propio pago:** modelo A.
- **Organizador o fotógrafo que quiere vender sin montar nada:** modelo B.
- **Carrera con patrocinador que paga las fotos:** modelo C.
- **Mezcla:** puedes usar un modelo distinto en cada evento.

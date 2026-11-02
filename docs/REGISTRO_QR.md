# Registro de corredores por QR

El organizador o fotógrafo imprime un QR (kit, meta, arco). El corredor lo escanea, deja su dorsal y su contacto
(correo y/o WhatsApp, con país) aceptando por separado cada canal, y recibe **un solo aviso agrupado** cuando haya
fotos suyas aprobadas. Se puede registrar antes de que el evento esté publicado.

## Piezas

| Qué | Dónde |
|---|---|
| Formulario público y baja | frontend `app/r/[code]`, `app/r/baja` |
| Panel (QR, póster, lista, CSV) | frontend pestaña **Registro QR** del evento; `components/events/event-runner-registration.tsx` |
| API pública | `POST/GET /v1/public/registrations/:code`, `GET/POST /v1/public/registrations/unsubscribe?t=` |
| API del panel | `GET/PATCH /v1/events/:id/registration`, `GET/DELETE /v1/events/:id/registrations`, `…/export.csv` |
| Partner API | permiso `registrations:read`, `GET /events/{id}/registrations`, `…/exports/registrations`, webhooks `runner.registered` y `runner.unsubscribed` (sin correo ni teléfono en la carga) |
| Aviso agrupado | worker `send-bib-email.processor.ts` (`processDigest`); programación en `digest-scheduler.service.ts` |
| Datos | `bib_subscriptions` (ampliada) y `bib_notification_log` (qué foto se avisó, a quién y por qué canal) |

## Reglas que conviene recordar

- **Un aviso por tanda.** Las fotos que llegan dentro de una ventana de 10 min comparten un único trabajo (`digest-{id}-{ventana}`).
  Cada canal lleva su propia cuenta en `bib_notification_log`: si WhatsApp falla y el correo no, el reintento solo repite WhatsApp.
- **Cuándo se programa un aviso:** al procesar una foto, al **publicar el evento**, al **aprobar** fotos (panel y Partner API) y al registrarse alguien
  cuyo dorsal ya tiene fotos. El envío solo ocurre con el evento publicado y fotos `PROCESSED` + `APPROVED` con marca de agua.
- **Consentimiento por canal**, con fecha y versión del texto (`REGISTRATION_CONSENT_VERSION` en `packages/shared/registration.ts`; súbela al cambiar el texto).
  Sin WhatsApp configurado el formulario no pide teléfono y la API lo rechaza.
- **Baja:** enlace firmado (HMAC con `REGISTRATION_SECRET`), página `/r/baja` con confirmación, y cabeceras `List-Unsubscribe` de un clic
  (requiere `API_URL` https). Quien se da de baja puede volver a registrarse.
- **Retención:** se borran los registros 180 días después del evento (`registration-retention.service.ts`, diario 05:00).
- **Abuso:** límite propio de 40/min por IP (la meta comparte wifi), tope de 60 registros por IP-hash y evento cada 10 min, campo trampa y
  Cloudflare Turnstile opcional. La IP solo se guarda como hash con sal.
- El registro cierra 30 días después de la fecha del evento.
- **Dominio propio:** el QR puede apuntar a `lucilamon.com/r/…` (por defecto) o al dominio verificado del espacio (`fotos.club.com/r/…`), a elección
  del organizador en el panel (`events.registration_use_custom_domain`). El middleware del frontend deja pasar `/r/*` en los dominios propios sin
  reescribirlo a `/s/{slug}`. Si el dominio deja de estar verificado, el QR vuelve solo a `lucilamon.com` y el panel avisa: **los QR ya impresos con el
  dominio propio dejan de abrir**. El enlace de baja de los correos siempre usa `lucilamon.com`.

## Canales de aviso: los del cliente, no los de LucilaMon

Cada espacio envía con **sus** cuentas: su Resend (correo) y su WhatsApp Business (Meta). Se conectan en el panel,
**Configuración del espacio → Avisos**, y se guardan cifradas (AES-256-GCM, llave `PARTNER_WEBHOOK_ENCRYPTION_KEY`); nunca se devuelven, solo sus últimos caracteres.
Código: `apps/api/src/messaging/`.

| Canal | Qué pega el cliente | Cómo se valida |
|---|---|---|
| Correo | Clave de Resend, remitente (`fotos@su-dominio.com`), nombre y respuesta opcionales | Lista sus dominios en Resend: el del remitente debe existir y estar verificado. Una clave «solo envío» no puede listar: queda pendiente hasta que un correo de prueba llegue. Se rechaza `resend.dev` (solo envía al propio dueño). |
| WhatsApp | Token permanente, ID del número y ID de la cuenta de WhatsApp Business | Comprueba token, que el número pertenezca a la cuenta, calidad, nivel de envío, estado del nombre y de la cuenta. Crea y manda a revisión las plantillas (es/en, categoría Utilidad, 4 variables). |

**Quién envía qué**

- Correo: con canal propio `ACTIVE` sale por su Resend; sin canal propio (o aún `PENDING`) sale por LucilaMon con el nombre del espacio como remitente.
- WhatsApp: **solo** con canal propio activo. Sin él, el formulario no pide teléfono. LucilaMon no paga mensajes de WhatsApp de nadie.
- Un canal activo requiere: plantilla aprobada por Meta **y** que el cliente **confirme que le llegó un mensaje de prueba real**. Meta acepta el mensaje antes de entregarlo (un fallo de pago puede llegar después), por eso la confirmación es manual.

**Cuando la cuenta del cliente falla** (sin método de pago, token vencido, dominio sin verificar, plantilla pausada…):

1. Cada error de Resend o de Meta se clasifica (`delivery-errors.ts`) como `ACCOUNT`, `TEMPLATE`, `RECIPIENT`, `LIMIT` o `TRANSIENT`.
2. `ACCOUNT`/`TEMPLATE`: el canal pasa a `ERROR` (se pausa), se guarda el motivo con **qué hacer y a dónde ir**, y se avisa por correo al contacto del espacio **una vez por motivo y día**. El texto dice que el problema está en su cuenta de Resend/Meta, no en LucilaMon. Los avisos **no se pierden**: quedan pendientes.
3. Al arreglarlo (verificar dominio, aprobar plantilla, confirmar prueba, botón *Reintentar*) el canal se reactiva y los avisos pendientes se reprograman solos.
4. `RECIPIENT` (correo o teléfono inválido, sin WhatsApp): solo se descarta ese aviso. `LIMIT` (cuota diaria de Resend, ritmo de Meta): se aplaza (hasta 72 veces) sin gastar reintentos. `TRANSIENT`: reintento normal de BullMQ.
5. Todo queda en `delivery_issues` (90 días) y se resume en el panel del evento: «Últimos 7 días sin enviar».
6. Opcional por canal de correo: *«Si mi correo falla, enviar desde LucilaMon»* (`fallbackToPlatform`), apagado por defecto.

**Plantillas de WhatsApp** (`whatsapp-templates.ts`): `lucilamon_fotos_listas_v{n}`, UTILITY. Si Meta rechaza una, se envía una versión nueva (`v2`…); un cron cada 15 min revisa las pendientes y avisa al cliente cuando se aprueban o rechazan, o si Meta la reclasifica como *Marketing* (más cara). Cuerpo (variables en orden: nombre, evento, nº de fotos, enlace):

> Hola {{1}}, ya están disponibles tus fotos de {{2}}: hay {{3}} con tu dorsal. Consúltalas aquí: {{4}} Gracias por participar.

**Lo que no se puede garantizar desde aquí**

- No hay confirmación de entrega: no recibimos los avisos (webhooks) de Meta ni de Resend. Un rebote o un `131026` asíncrono no se ve; el correo rebotado tampoco. Es lo siguiente a construir (rebotes y quejas de Resend protegen la reputación del dominio del cliente).
- Meta puede aceptar un mensaje y no cobrarlo/entregarlo por facturación: por eso la prueba real y la confirmación manual.
- Los nombres de error de Resend y los códigos de Meta están mapeados de su documentación; un código nuevo cae en `TRANSIENT` (se reintenta, no pausa).
- Para pruebas hay dos variables: `RESEND_API_BASE` y `WHATSAPP_GRAPH_BASE` (apuntar a un proveedor simulado).

## Variables

Ver `.env.example` y `.env.production.example`. `REGISTRATION_SECRET` es **obligatorio en producción** (la API no arranca sin él).
`RESEND_API_KEY`/`EMAIL_FROM` solo se usan para los espacios que no conectaron su propio correo y para las alertas a los clientes.

## Pendiente antes de anunciarlo

- Revisión legal del texto de consentimiento y de la política de privacidad (ya actualizada). WhatsApp exige opt-in explícito.
- Probar con una cuenta real de Resend y de WhatsApp Business (hasta ahora solo con proveedores simulados).
- Responder a «STOP» por webhook de Meta; rebotes y quejas de Resend.
- La migración `20261101000000_runner_registrations` incluye un índice único parcial (teléfono) que Prisma no representa en el esquema:
  `prisma migrate dev` puede proponer borrarlo; no lo aceptes.

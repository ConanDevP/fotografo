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

## Variables

Ver `.env.example` y `.env.production.example`. `REGISTRATION_SECRET` es **obligatorio en producción** (la API no arranca sin él).

### WhatsApp (opcional)

Meta Cloud API. Solo puede abrir conversación con una **plantilla aprobada** (categoría *Utility*), con 4 variables en el cuerpo:

> Hola {{1}}, ya hay {{3}} foto(s) tuyas de {{2}}. Míralas aquí: {{4}}

Variables: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TEMPLATE_ES` (y `WHATSAPP_TEMPLATE_EN`). Un fallo permanente (número sin WhatsApp,
plantilla inexistente) se da por avisado para no reintentar sin fin; uno pasajero (429/5xx) se reintenta.
Falta aún: responder a "STOP" por webhook de Meta; mientras tanto la baja es por el enlace.

## Pendiente antes de anunciarlo

- Revisión legal del texto de consentimiento y de la política de privacidad (ya actualizada). WhatsApp exige opt-in explícito.
- Aprobar la plantilla en Meta y probar con un número real.
- Probar el correo con el dominio verificado en Resend (cabeceras de baja incluidas).
- La migración `20261101000000_runner_registrations` incluye un índice único parcial (teléfono) que Prisma no representa en el esquema:
  `prisma migrate dev` puede proponer borrarlo; no lo aceptes.

# Pagos manuales y reglas de ingresos

## Para qué sirve

El comprador paga en USD (o la moneda del evento) a la cuenta de Stripe de la empresa. Si el fotógrafo u organizador **no puede** conectar Stripe Connect, su parte queda en el libro contable como pendiente y el administrador se la paga por fuera.

## Pantalla de administrador: `/admin/payouts` («Pagos pendientes»)

Solo rol `ADMIN`. API: `GET /admin/payouts`, `POST /admin/payouts/mark-paid`, `POST /admin/payouts/mark-recovered` (20 peticiones por minuto en los dos `POST`).

| Sección | Qué muestra |
|---|---|
| Por pagar | Una fila por persona **y moneda**, con el detalle de cada venta. «Stripe se lo paga solo» si ya puede recibir por Stripe |
| Pagado y luego reembolsado | Importes pagados a mano cuyo pedido se reembolsó o entró en disputa |
| Pagos recientes | Historial: persona, medio, referencia, fecha |

### Registrar un pago

1. Haz el pago por fuera (banco, Payoneer, PayPal, efectivo u otro).
2. En «Por pagar» pulsa **Marcar como pagado**: elige el medio, escribe la **referencia** (obligatoria) y, si quieres, una nota interna.
3. Se marca todo lo de esa persona en esa moneda. El sistema envía un **correo al beneficiario** con monto, medio y referencia (sin la nota interna). Si el correo no sale, el pago queda registrado igual y la pantalla lo avisa.

El fotógrafo ve el medio y la referencia en sus ganancias («pagado el … · transferencia bancaria · ref. …»).

Reglas que el sistema impone:

- Todo o nada: si un importe cambió de estado mientras preparabas el pago, no se marca ninguno.
- No se paga dos veces el mismo importe, ni aunque dos administradores lo marquen a la vez.
- Una persona y una moneda por pago.
- No se paga a mano a quien Stripe ya puede pagar (se le transfiere solo), ni pedidos reembolsados, con reembolso en curso, en disputa, o que Stripe esté liquidando en ese momento.
- Cada pago queda en `AuditLog` con acción `MANUAL_PAYOUT`.

En el libro, el importe pasa a `PAID_OUT` **sin** `externalTransferId` (eso lo distingue de una transferencia de Stripe) y guarda `metadata.manualPayout`.

### Reembolso o disputa después de pagar a mano

Stripe no puede revertir un pago que no hizo. El comprador recibe su reembolso igualmente; el importe queda `PAID_OUT`, marcado «pendiente de ajuste», y aparece en **Pagado y luego reembolsado**.

Allí pulsa **Registrar ajuste** (por persona y moneda) y elige cómo se resolvió:

- transferencia, Payoneer, PayPal, efectivo u otro → **referencia obligatoria**;
- **Descontado de un pago posterior** o **Lo asumimos (no se cobra)** → sin referencia.

El sistema solo deja constancia (`AuditLog`: `MANUAL_PAYOUT_RECOVERED`) y no se puede registrar dos veces. **El dinero no se mueve por el sistema**: «descontado» significa que tú pagas menos la próxima vez.

## Reglas de ingresos (para leer cualquier cifra)

- Las monedas **nunca se suman**. Las respuestas traen los campos de siempre y además `currency`, `byCurrency` (o `revenueByCurrency` / `earnedByCurrency`) y `mixedCurrencies`.
- Los pedidos reembolsados o en disputa no cuentan como ingreso.
- El periodo de una venta es la fecha en que se **cobró** (`paidAt`); si no existe, la de creación.
- Un pago con importe o moneda distintos de los del pedido no se acepta y deja `PAYMENT_MISMATCH` en `AuditLog`.
- El importe de Stripe se compara sin impuestos.

## Pendiente

- Probar una tarjeta hondureña real en USD.
- Consultar con contador o abogado la custodia de dinero de terceros.

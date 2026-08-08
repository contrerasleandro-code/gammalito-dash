# Patch: sub_id + current_period_end en el refresh de Stripe

## Por qué
`Cash Flow` reconstruye la próxima fecha de cobro como `created + N meses`
cuando no tiene otra cosa. Es una aproximación: no sabe si hubo un cambio de
plan, una pausa, o simplemente drift de redondeo. La fecha real ya existe en
Stripe como `current_period_end` de cada `subscription_item` — solo falta
guardarla en el JSON que arma el refresh.

El dashboard (`index.html`, build.292) ya está listo para consumir estos dos
campos nuevos si aparecen — es 100% retrocompatible: si faltan, sigue
reconstruyendo como hasta ahora.

## Qué agregar a cada fila de `RAW`

Estructura actual de una fila:
```json
{"c": 1785279285, "s": "active", "p": "prod_TuHNjZlIfwH37V", "a": 40000, "i": "month", "n": 3, "cus": "cus_UyGQ120YVrVdxu"}
```

Agregar dos campos opcionales:
```json
{"c": 1785279285, "s": "active", "p": "prod_TuHNjZlIfwH37V", "a": 40000, "i": "month", "n": 3, "cus": "cus_UyGQ120YVrVdxu",
 "id": "sub_1TydhUBurqw7bwgolsu9xgnk",
 "cpe": 1788791279}
```
- `id`: el subscription id de Stripe (`sub_...`). También sirve para el
  pendiente que ya tenías anotado de atribución `INV_DATA` → producto.
- `cpe`: `items.data[0].current_period_end` del subscription item (epoch
  segundos) — la fecha real del próximo cobro.

## Dónde tocar en la llamada a Stripe

Al listar subscripciones (`GetSubscriptions` / `search_stripe_resources`),
ya estás iterando cada `sub` para armar la fila de `RAW`. Justo ahí:

```js
// Antes:
RAW.push({
  c: sub.created,
  s: sub.status,
  p: item.price.product,
  a: item.price.unit_amount,
  i: item.price.recurring.interval,
  n: item.price.recurring.interval_count,
  cus: sub.customer,
  ...(sub.cancel_at || sub.canceled_at ? { ca: sub.cancel_at || sub.canceled_at } : {})
});

// Después — agregar id y cpe:
RAW.push({
  c: sub.created,
  s: sub.status,
  p: item.price.product,
  a: item.price.unit_amount,
  i: item.price.recurring.interval,
  n: item.price.recurring.interval_count,
  cus: sub.customer,
  ...(sub.cancel_at || sub.canceled_at ? { ca: sub.cancel_at || sub.canceled_at } : {}),
  id: sub.id,
  cpe: item.current_period_end,   // OJO: current_period_end vive en el subscription ITEM, no en el sub top-level
});
```

No hace falta ningún expand ni llamada extra — `current_period_end` ya viene
en la respuesta normal de `GetSubscriptions` / `GetSubscriptionsSubscriptionExposedId`,
dentro de `items.data[0].current_period_end`.

## Para las suscripciones en trial

Si armás la fila de trials por separado, usá lo mismo: `id: sub.id`,
`cpe: item.current_period_end` (que en trial coincide con `trial_end`).

## Qué NO hace falta cambiar

- No hace falta cambiar `CUS_MRR`, `CMAP`, `INV_DATA` ni el resto del
  refresh — esto es aditivo, dos campos nuevos por fila.
- No hace falta migrar filas viejas — el dashboard mezcla filas con y sin
  `cpe` sin problema (usa reconstrucción solo donde falta).

## Cómo verificar que funcionó

Después de refrescar, en la pestaña Cash Flow el texto bajo "Detalle" debería
dejar de decir "N/N cobros con fecha reconstruida" (o el número debería
bajar a ~0 para las suscripciones cuyo refresh ya trajo `cpe`).

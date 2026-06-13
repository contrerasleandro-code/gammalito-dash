# GAMMALito Dashboard — Servidor con refresh on-demand

## Qué incluye
- `index.html` — el dashboard (mismo diseño/funcionalidad, ahora con `let` en lugar de `const` para los datos que se actualizan).
- `api/refresh.js` — función serverless que consulta Stripe en vivo y devuelve los datos actualizados.
- `package.json` — declara la dependencia `stripe`.

## Pasos para desplegar en Vercel

1. **Crear cuenta** en https://vercel.com (gratis) si no tenés.

2. **Subir este proyecto**:
   - Opción fácil: arrastrá esta carpeta a https://vercel.com/new (drag & drop), o
   - Subila a un repo de GitHub y conectá ese repo desde Vercel.

3. **Configurar la variable de entorno** (Project Settings → Environment Variables):
   - `STRIPE_SECRET_KEY` = tu clave secreta de Stripe.
     - Recomendado: crear una **Restricted key** en Stripe (Developers → API keys → Create restricted key) con permiso de **lectura** sobre Subscriptions, Invoices y Customers. Así, aunque alguien la viera, no podría hacer cambios ni cobros.

4. **Deploy**. Vercel te da una URL tipo `https://gammalito-dashboard.vercel.app`.

5. Abrí esa URL — el dashboard carga con los datos del último build. Apretá el botón **"Actualizar"**: llama a `/api/refresh`, que consulta Stripe en vivo (suscripciones + facturas), y el dashboard se re-renderiza con los datos frescos, sin recargar la página.

## Notas importantes

- **Cada click en "Actualizar" hace varias llamadas a la API de Stripe** (pagina por pagina, 100 registros por vez). Con ~700 suscripciones y ~1200 facturas, son unas 20 llamadas — tarda unos segundos pero no tiene costo en Stripe.

- **CMAP (nombres/emails de clientes)**: se reconstruye desde `customer_name`/`customer_email` de las facturas, igual que en el flujo anterior.

- **Cálculo de "net"**: para que coincida con tu MRR corregido, la función intenta leer `balance_transaction.net` de cada cobro (el monto neto después de la comisión de Stripe). Si por algún motivo Stripe no devuelve ese campo expandido para una factura puntual, usa `amount_paid` como respaldo.

- **CUS_MRR**: se reconstruye tomando, para cada suscripción activa/trialing, el `unit_amount` e `interval_count` del primer item — igual que el dataset original.

- Si en algún momento agregás productos nuevos en Stripe, recordá actualizar el objeto `PM` (mapa de nombres de producto) directamente en `index.html`, ya que ese mapa es estático y no se regenera automáticamente.

## Seguridad

- La Stripe key **nunca** está en el HTML ni se envía al navegador — vive solo como variable de entorno del servidor.
- `api/refresh.js` solo expone datos ya agregados (montos, fechas, nombres de cliente), igual que lo que ya mostraba el dashboard estático.

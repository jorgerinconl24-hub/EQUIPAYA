# Equipaya

Tienda en línea para equipar negocios: mobiliario, pisos, iluminación, revestimientos, equipos y suministros. Incluye ventas en vivo y una sección para ver el local armado en 2D y 3D.

## Qué hay en este repo

| Archivo | Qué es |
|---|---|
| `index.html` | La tienda: catálogo, ofertas flash, carrito y pedido por WhatsApp, y ventas en vivo |
| `local.html` | **Ver tu negocio**: medidas o plano, tipo de negocio, armado automático y vista 2D y 3D |
| `host.html` | Panel del vendedor para las ventas en vivo, y panel de los agentes para crear transmisiones |
| `server/` | Servidor (Node + Express + Socket.IO) para las ventas en vivo y la lectura de planos con IA |
| `render.yaml` | Configuración para crear el servidor en Render |

## Publicar la tienda (GitHub Pages)

1. En el repo ve a **Settings → Pages**.
2. En **Source** elige `Deploy from a branch`, rama `main` y carpeta `/ (root)`.
3. La tienda queda en `https://TU-USUARIO.github.io/equipaya/`.

## Publicar el servidor (Render)

1. En Render ve a **New → Blueprint** y elige este repo. Render lee `render.yaml` y crea `equipaya-server`.
2. Llena las variables que pide:
   - `FIREBASE_SERVICE_ACCOUNT`: el JSON de la cuenta de servicio del proyecto Firebase **de Equipaya** (Firebase → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada). Pega el JSON completo.
   - `ANTHROPIC_API_KEY`: la clave para leer planos con IA.
   - `LIVE_ORIGINS`: `https://TU-USUARIO.github.io`
   - `LIVE_ADMIN_KEY` se genera sola. Cópiala de Render: es la clave de los agentes para crear en vivos.
3. Si Render le pone otro nombre al servicio, cambia la dirección `https://equipaya-server.onrender.com` en `index.html`, `local.html` y `host.html`.

## Probar el servidor en tu computadora

```bash
cd server
npm install
npm test      # prueba completa de ventas en vivo (sin Firebase, base en memoria)
npm start     # servidor en http://localhost:3000
```

## Pendiente

- Catálogo y precios reales (la tienda y `local.html` usan datos de ejemplo).
- Número de WhatsApp de ventas (`WHATSAPP` en `local.html` y el botón del carrito en `index.html`).
- Video en vivo (Amazon IVS, LiveKit u otro): el sistema ya acepta un enlace HLS por transmisión.
- Reglas de distribución por tipo de negocio (`NEGOCIOS` en `local.html`), revisadas por el equipo.

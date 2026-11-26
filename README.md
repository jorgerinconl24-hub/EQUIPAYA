# Equipaya

Tienda en línea para equipar negocios: mobiliario, pisos, iluminación, revestimientos, equipos y suministros. Incluye ventas en vivo y una sección para ver el local armado en 2D y 3D.

## Qué hay en este repo

| Archivo | Qué es |
|---|---|
| `index.html` | La tienda: catálogo, ofertas flash, carrito y pedido por WhatsApp, y ventas en vivo |
| `recomendador.js` | **Recomendador**: registra lo que hace cada cliente y ordena el feed "Recomendado para ti" según su tipo de negocio y sus gustos |
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

## Recomendador (fase 1)

El feed "Recomendado para ti" se ordena para cada cliente según:

- El **tipo de negocio** que va a montar (se le pregunta al entrar; también lo toma de "Ver tu negocio").
- Lo que ve, cuánto tiempo mira cada producto, lo que agrega al carrito y lo que pide por WhatsApp. Los gustos viejos pierden fuerza con el tiempo.
- **Complementos**: si tiene vitrinas en el carrito, le sube iluminación y revestimientos.
- Lo que más piden **otros negocios como el suyo** (lo calcula el servidor en `/eventos/populares`).
- Baja lo que ya pidió (menos los suministros, que se recompran) y lo que ve muchas veces sin abrir.

Todo lo que hace cada cliente se guarda en Firestore (colección `eventos`), sin nombre ni teléfono. Esa data es la base para la fase 2 y la fase 3.

Las reglas están arriba de `recomendador.js` (`NEGOCIOS`, `COMPLEMENTOS`, `PESOS`, `W`) para ajustarlas con la experiencia del equipo. Para ver por qué un producto sale donde sale, abre la consola del navegador y escribe `Eqy.explicar(products[6])`.

## Probar el servidor en tu computadora

```bash
cd server
npm install
npm test           # prueba completa de ventas en vivo (sin Firebase, base en memoria)
npm run test:reco  # prueba del recomendador
npm start          # servidor en http://localhost:3000
```

## Pendiente

- Catálogo y precios reales (la tienda y `local.html` usan datos de ejemplo).
- Número de WhatsApp de ventas (`WHATSAPP` en `local.html` y el botón del carrito en `index.html`).
- Video en vivo (Amazon IVS, LiveKit u otro): el sistema ya acepta un enlace HLS por transmisión.
- Reglas de distribución por tipo de negocio (`NEGOCIOS` en `local.html`), revisadas por el equipo.

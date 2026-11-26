/* =====================================================================
   Equipaya — Eventos del recomendador (fase 1)
   POST /eventos                      Recibe lotes de eventos de la tienda
        cuerpo: {"eventos":[{tipo, uid, sid, ts, pid, dept, negocio, q, seg, qty, live, area, pagina}]}
   GET  /eventos/populares?negocio=farmacia
        Devuelve lo que más piden los negocios de ese tipo:
        {"negocio":"farmacia","productos":[{"pid":"6","puntos":12}, ...]}

   Firestore:
     eventos/{auto}                 un documento por evento (base de la fase 2 y 3)
     populares/{negocio}__{pid}     puntos acumulados por tipo de negocio y producto
   ===================================================================== */
'use strict';

const TIPOS = new Set(['ver_producto', 'tiempo_ficha', 'agregar_carrito', 'comprar_ahora', 'pedir_whatsapp',
  'quitar_carrito', 'buscar', 'filtrar_depto', 'filtrar_negocio', 'elegir_negocio', 'ver_live', 'local_armado']);
const NEGOCIOS = new Set(['bodega', 'super', 'farmacia', 'boutique', 'panaderia', 'ferreteria']);

// Puntos que suma cada acción a "lo que piden los negocios como el tuyo".
const PUNTOS_POPULARES = { agregar_carrito: 1, comprar_ahora: 1, pedir_whatsapp: 3 };

const MAX_LOTE = 50;
const MAX_POR_MINUTO = 240;              // eventos por IP por minuto
const CACHE_MS = 5 * 60 * 1000;          // populares en memoria 5 minutos

const txt = (v, n) => (v == null ? undefined : String(v).slice(0, n));
const num = (v, min, max) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : undefined;
};

function limpiar(e, ahora) {
  if (!e || typeof e !== 'object' || !TIPOS.has(e.tipo)) return null;
  const uid = txt(e.uid, 64);
  if (!uid) return null;
  const ts = num(e.ts, ahora - 7 * 864e5, ahora + 60e3) ?? ahora;   // eventos de hasta 7 días (cola sin conexión)
  const o = {
    tipo: e.tipo, uid, sid: txt(e.sid, 64), ts, recibido: ahora,
    pid: txt(e.pid, 40), dept: txt(e.dept, 12),
    negocio: NEGOCIOS.has(e.negocio) ? e.negocio : undefined,
    q: txt(e.q, 60), seg: num(e.seg, 0, 3600), qty: num(e.qty, 0, 10000),
    live: txt(e.live, 40), area: num(e.area, 0, 100000), pagina: txt(e.pagina, 40)
  };
  Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);
  return o;
}

module.exports = function ({ app, db, admin, express }) {
  const r = express.Router();
  const origins = (process.env.LIVE_ORIGINS || '*').split(',').map(s => s.trim());

  r.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && (origins.includes('*') || origins.includes(o))) {
      res.set('Access-Control-Allow-Origin', o);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // La tienda envía text/plain (sendBeacon) o JSON.
  r.use(express.text({ type: 'text/plain', limit: '64kb' }));

  // Límite simple por IP
  const contador = new Map();
  setInterval(() => contador.clear(), 60e3).unref();

  // Un mismo cliente suma a "populares" una sola vez por producto, acción y día.
  const yaContado = new Set();
  let diaContado = new Date().toISOString().slice(0, 10);

  r.post('/', async (req, res) => {
    let cuerpo = req.body;
    if (typeof cuerpo === 'string') { try { cuerpo = JSON.parse(cuerpo); } catch { return res.status(400).json({ error: 'JSON inválido' }); } }
    const lista = Array.isArray(cuerpo?.eventos) ? cuerpo.eventos.slice(0, MAX_LOTE) : null;
    if (!lista) return res.status(400).json({ error: 'Falta la lista de eventos' });

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const n = (contador.get(ip) || 0) + lista.length;
    contador.set(ip, n);
    if (n > MAX_POR_MINUTO) return res.status(429).json({ error: 'Demasiados eventos, intenta en un minuto' });

    const ahora = Date.now();
    const hoy = new Date().toISOString().slice(0, 10);
    if (hoy !== diaContado) { yaContado.clear(); diaContado = hoy; }

    const limpios = lista.map(e => limpiar(e, ahora)).filter(Boolean);
    try {
      await Promise.all(limpios.map(e => db.collection('eventos').add(e)));
      // Populares uno por uno, para que dos sumas al mismo producto no se pisen
      for (const e of limpios) {
        const puntos = PUNTOS_POPULARES[e.tipo];
        if (!puntos || !e.negocio || !e.pid) continue;
        const llave = `${e.uid}|${e.pid}|${e.tipo}`;
        if (yaContado.has(llave)) continue;
        yaContado.add(llave);
        await sumarPopular(e.negocio, e.pid, puntos, ahora);
      }
      res.json({ ok: true, guardados: limpios.length });
    } catch (err) {
      console.error('[eventos] error guardando', err);
      res.status(500).json({ error: 'No se pudieron guardar los eventos' });
    }
  });

  async function sumarPopular(negocio, pid, puntos, ahora) {
    const ref = db.collection('populares').doc(`${negocio}__${pid}`.replace(/\//g, '_'));
    if (admin) {
      await ref.set({ negocio, pid, puntos: admin.firestore.FieldValue.increment(puntos), actualizado: ahora }, { merge: true });
    } else {
      const d = await ref.get();
      await ref.set({ negocio, pid, puntos: ((d.exists && d.data().puntos) || 0) + puntos, actualizado: ahora });
    }
    cache.delete(negocio);
  }

  const cache = new Map();
  r.get('/populares', async (req, res) => {
    const negocio = String(req.query.negocio || '');
    if (!NEGOCIOS.has(negocio)) return res.status(400).json({ error: 'Tipo de negocio no válido' });
    const c = cache.get(negocio);
    if (c && Date.now() - c.t < CACHE_MS) return res.json(c.datos);
    try {
      const snap = await db.collection('populares').where('negocio', '==', negocio).limit(500).get();
      const productos = snap.docs.map(d => d.data())
        .map(d => ({ pid: String(d.pid), puntos: d.puntos || 0 }))
        .sort((a, b) => b.puntos - a.puntos)
        .slice(0, 40);
      const datos = { negocio, productos };
      cache.set(negocio, { t: Date.now(), datos });
      res.set('Cache-Control', 'public, max-age=60');
      res.json(datos);
    } catch (err) {
      console.error('[eventos] error leyendo populares', err);
      res.status(500).json({ error: 'No se pudieron leer los populares' });
    }
  });

  app.use('/eventos', r);
};

/**
 * live.js — Ventas en vivo de Equipaya (Socket.IO + Firestore)
 *
 * Uso en tu server.js (Express en Render):
 *
 *   const http = require('http');
 *   const server = http.createServer(app);           // en vez de app.listen(...)
 *   require('./live')({ server, app, db, admin, express });
 *   server.listen(PORT);
 *
 * Variables de entorno (Render → Environment):
 *   LIVE_ADMIN_KEY     Clave de tus agentes para crear en vivos y mover pedidos (obligatoria)
 *   LIVE_ORIGINS       Orígenes permitidos separados por coma (ej: https://jorgerinconl24-hub.github.io). Por defecto "*"
 *   LIVE_REQUIRE_AUTH  "1" para exigir token de Firebase Auth al pujar/comprar. Por defecto "0"
 *
 * Colecciones Firestore:
 *   lives/{liveId}                 Datos del en vivo (sin la clave del vendedor en claro)
 *   lives/{liveId}/pujas/{id}      Historial de pujas
 *   lives/{liveId}/mensajes/{id}   Chat
 *   pedidos_live/{id}              Pedidos con pago retenido
 */
'use strict';

const crypto = require('crypto');
const { Server } = require('socket.io');

const ESTADOS_PEDIDO = {
  // estado actual      -> estados a los que puede pasar
  pendiente_pago:   ['pagado_retenido', 'cancelado'],
  pagado_retenido:  ['enviado', 'reembolsado'],
  enviado:          ['entregado', 'reembolsado'],
  entregado:        ['liberado'],          // aquí se le paga al vendedor
  liberado:         [],
  cancelado:        [],
  reembolsado:      []
};

const ANTI_SNIPE_MS = 10_000;   // si pujan en los últimos 10 s, la subasta se extiende a 10 s
const CHAT_GAP_MS   = 1_200;    // un mensaje cada 1.2 s por persona
const CHAT_MAX      = 200;      // caracteres por mensaje
const CHAT_MEMORIA  = 40;       // mensajes que recibe quien entra

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const limpiar = (s, n = CHAT_MAX) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const incrementoMinimo = bid => (bid < 50 ? 1 : bid < 200 ? 5 : bid < 1000 ? 10 : 25);
const now = () => Date.now();

module.exports = function attachLive({ server, app, db, admin, express }) {
  if (!process.env.LIVE_ADMIN_KEY) console.warn('[live] Falta LIVE_ADMIN_KEY: no se podrán crear en vivos.');
  const ADMIN_KEY = process.env.LIVE_ADMIN_KEY || '';
  const REQUIRE_AUTH = process.env.LIVE_REQUIRE_AUTH === '1';
  const origins = (process.env.LIVE_ORIGINS || '*').split(',').map(s => s.trim());
  const FieldValue = admin?.firestore?.FieldValue;
  const ts = () => (FieldValue ? FieldValue.serverTimestamp() : new Date());

  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: origins.includes('*') ? true : origins, methods: ['GET', 'POST'] }
  });

  /** Estado en memoria por en vivo */
  const salas = new Map();
  /*
    salas.get(liveId) = {
      live,               // copia del documento
      idx,                // producto fijado
      subasta: null | { idx, bid, lider, inicio, finEn, timer, pujas },
      stock: { [idx]: unidades },
      chat: [],
      likes
    }
  */

  async function cargarSala(liveId) {
    if (salas.has(liveId)) return salas.get(liveId);
    const snap = await db.collection('lives').doc(liveId).get();
    if (!snap.exists) return null;
    const live = { id: snap.id, ...snap.data() };
    const stock = {};
    (live.items || []).forEach((it, i) => { stock[i] = Number.isFinite(it.stock) ? it.stock : 9999; });
    const sala = { live, idx: live.idxActual || 0, subasta: null, stock, chat: [], likes: 0 };
    salas.set(liveId, sala);
    return sala;
  }

  const espectadores = liveId => io.sockets.adapter.rooms.get(liveId)?.size || 0;

  function publico(live) {
    const { hostKeyHash, ...resto } = live;
    return resto;
  }

  function estadoParaCliente(sala) {
    const s = sala.subasta;
    return {
      live: publico(sala.live),
      idx: sala.idx,
      stock: sala.stock,
      subasta: s ? { idx: s.idx, bid: s.bid, lider: s.lider ? s.lider.nombre : null, finEn: s.finEn, abierta: !!s.timer } : null,
      espectadores: espectadores(sala.live.id),
      likes: sala.likes,
      chat: sala.chat.slice(-CHAT_MEMORIA)
    };
  }

  // ---------- Identidad del comprador ----------
  async function identificar(user, idToken) {
    const nombre = limpiar(user?.nombre, 30) || 'Invitado';
    const tel = limpiar(user?.tel, 20);
    if (idToken && admin?.auth) {
      try {
        const dec = await admin.auth().verifyIdToken(idToken);
        return { id: 'uid:' + dec.uid, nombre, tel: tel || dec.phone_number || '', verificado: true };
      } catch (e) { /* token inválido: sigue como anónimo */ }
    }
    const anon = limpiar(user?.id, 64) || crypto.randomUUID();
    return { id: 'anon:' + anon, nombre, tel, verificado: false };
  }

  // ---------- Subastas ----------
  function programarCierre(liveId, sala) {
    const s = sala.subasta;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => cerrarSubasta(liveId, sala).catch(e => console.error('[live] cierre', e)), Math.max(0, s.finEn - now()));
  }

  async function cerrarSubasta(liveId, sala) {
    const s = sala.subasta;
    if (!s || !s.timer) return;
    clearTimeout(s.timer);
    s.timer = null;
    const item = sala.live.items[s.idx];
    let pedidoId = null;
    if (s.lider) {
      pedidoId = await crearPedido({ liveId, sala, idx: s.idx, monto: s.bid, comprador: s.lider, tipo: 'subasta' });
      if (sala.stock[s.idx] < 9999) sala.stock[s.idx] = Math.max(0, sala.stock[s.idx] - 1);
    }
    io.to(liveId).emit('live:resultado', {
      idx: s.idx,
      titulo: item.titulo,
      monto: s.bid,
      ganador: s.lider ? s.lider.nombre : null,
      ganadorId: s.lider ? s.lider.id : null,
      pedidoId
    });
    sistema(liveId, sala, s.lider ? `🔨 Vendido a ${s.lider.nombre} por $${s.bid}` : `Sin pujas para ${item.titulo}`);
  }

  async function crearPedido({ liveId, sala, idx, monto, comprador, tipo }) {
    const item = sala.live.items[idx];
    const ref = await db.collection('pedidos_live').add({
      liveId,
      vendedor: sala.live.vendedor?.nombre || '',
      item: { idx, titulo: item.titulo, pid: item.pid ?? null },
      monto,
      tipo,                                  // 'subasta' | 'fijo'
      comprador: { id: comprador.id, nombre: comprador.nombre, tel: comprador.tel || '', verificado: !!comprador.verificado },
      estado: 'pendiente_pago',
      historial: [{ estado: 'pendiente_pago', en: new Date().toISOString() }],
      creado: ts()
    });
    return ref.id;
  }

  function sistema(liveId, sala, texto) {
    const m = { tipo: 'sys', texto, en: now() };
    sala.chat.push(m);
    if (sala.chat.length > 200) sala.chat.splice(0, 100);
    io.to(liveId).emit('live:chat', m);
  }

  // ---------- Sockets ----------
  io.on('connection', socket => {
    socket.data.ultimoChat = 0;

    socket.on('live:join', async ({ liveId, user, idToken } = {}, ack = () => {}) => {
      try {
        liveId = limpiar(liveId, 64);
        const sala = await cargarSala(liveId);
        if (!sala) return ack({ ok: false, error: 'Este en vivo no existe.' });
        if (sala.live.estado !== 'en_vivo') return ack({ ok: false, error: 'Este en vivo todavía no ha empezado o ya terminó.' });
        socket.data.liveId = liveId;
        socket.data.user = await identificar(user, idToken);
        socket.join(liveId);
        ack({ ok: true, yo: { id: socket.data.user.id, nombre: socket.data.user.nombre }, estado: estadoParaCliente(sala) });
        io.to(liveId).emit('live:espectadores', espectadores(liveId));
      } catch (e) { console.error('[live] join', e); ack({ ok: false, error: 'No se pudo entrar. Intenta de nuevo.' }); }
    });

    socket.on('host:join', async ({ liveId, hostKey } = {}, ack = () => {}) => {
      try {
        const sala = await cargarSala(limpiar(liveId, 64));
        if (!sala) return ack({ ok: false, error: 'En vivo no encontrado.' });
        if (!hostKey || sha(hostKey) !== sala.live.hostKeyHash) return ack({ ok: false, error: 'Clave de vendedor incorrecta.' });
        socket.data.liveId = sala.live.id;
        socket.data.host = true;
        socket.data.user = { id: 'host:' + sala.live.id, nombre: sala.live.vendedor?.nombre || 'Vendedor', tel: '', verificado: true };
        socket.join(sala.live.id);
        ack({ ok: true, estado: estadoParaCliente(sala) });
      } catch (e) { console.error('[live] host', e); ack({ ok: false, error: 'Error del servidor.' }); }
    });

    socket.on('live:chat', async ({ texto } = {}) => {
      const { liveId, user } = socket.data;
      const sala = liveId && salas.get(liveId);
      if (!sala || !user) return;
      if (now() - socket.data.ultimoChat < CHAT_GAP_MS) return;
      texto = limpiar(texto);
      if (!texto) return;
      socket.data.ultimoChat = now();
      const m = { tipo: socket.data.host ? 'host' : 'msg', nombre: user.nombre, texto, en: now() };
      sala.chat.push(m);
      if (sala.chat.length > 200) sala.chat.splice(0, 100);
      io.to(liveId).emit('live:chat', m);
      db.collection('lives').doc(liveId).collection('mensajes').add({ ...m, uid: user.id, creado: ts() }).catch(() => {});
    });

    socket.on('live:like', () => {
      const { liveId } = socket.data;
      const sala = liveId && salas.get(liveId);
      if (!sala) return;
      const t = now();
      if (t - (socket.data.ultimoLike || 0) < 300) return;
      socket.data.ultimoLike = t;
      sala.likes++;
      socket.to(liveId).emit('live:like', sala.likes);
    });

    socket.on('live:bid', async ({ monto } = {}, ack = () => {}) => {
      const { liveId, user } = socket.data;
      const sala = liveId && salas.get(liveId);
      const s = sala?.subasta;
      if (!s || !s.timer) return ack({ ok: false, error: 'No hay subasta abierta.' });
      if (socket.data.host) return ack({ ok: false, error: 'El vendedor no puede pujar.' });
      if (REQUIRE_AUTH && !user.verificado) return ack({ ok: false, error: 'Inicia sesión para pujar.' });
      if (!user.tel) return ack({ ok: false, error: 'Agrega tu teléfono para poder pujar.' });
      monto = Number(monto);
      const minimo = s.lider ? s.bid + incrementoMinimo(s.bid) : s.bid;
      if (!Number.isFinite(monto) || monto < minimo) return ack({ ok: false, error: `La puja mínima es $${minimo}.`, minimo });
      if (monto > s.bid * 5 + 1000) return ack({ ok: false, error: 'Monto fuera de rango.' });
      if (now() >= s.finEn) return ack({ ok: false, error: 'La subasta ya cerró.' });

      s.bid = Math.round(monto * 100) / 100;
      s.lider = user;
      s.pujas++;
      if (s.finEn - now() < ANTI_SNIPE_MS) { s.finEn = now() + ANTI_SNIPE_MS; programarCierre(liveId, sala); }
      io.to(liveId).emit('live:puja', { idx: s.idx, bid: s.bid, lider: user.nombre, liderId: user.id, finEn: s.finEn });
      ack({ ok: true });
      db.collection('lives').doc(liveId).collection('pujas').add({ idx: s.idx, monto: s.bid, uid: user.id, nombre: user.nombre, creado: ts() }).catch(() => {});
    });

    socket.on('live:buy', async ({ idx } = {}, ack = () => {}) => {
      try {
        const { liveId, user } = socket.data;
        const sala = liveId && salas.get(liveId);
        if (!sala) return ack({ ok: false, error: 'No estás en un en vivo.' });
        idx = Number.isInteger(idx) ? idx : sala.idx;
        const item = sala.live.items[idx];
        if (!item || item.modo !== 'fijo') return ack({ ok: false, error: 'Este producto no está a precio fijo.' });
        if (idx !== sala.idx) return ack({ ok: false, error: 'Este producto ya no está en pantalla.' });
        if (REQUIRE_AUTH && !user.verificado) return ack({ ok: false, error: 'Inicia sesión para comprar.' });
        if (!user.tel) return ack({ ok: false, error: 'Agrega tu teléfono para comprar.' });
        if (sala.stock[idx] <= 0) return ack({ ok: false, error: 'Agotado.' });
        if (sala.stock[idx] < 9999) sala.stock[idx]--;
        const pedidoId = await crearPedido({ liveId, sala, idx, monto: item.precio, comprador: user, tipo: 'fijo' });
        io.to(liveId).emit('live:stock', { idx, quedan: sala.stock[idx] });
        sistema(liveId, sala, `🛒 ${user.nombre} compró ${item.titulo}`);
        ack({ ok: true, pedidoId });
      } catch (e) { console.error('[live] buy', e); ack({ ok: false, error: 'No se pudo registrar la compra.' }); }
    });

    // ---- Controles del vendedor ----
    function soloHost(fn) {
      return async (data = {}, ack = () => {}) => {
        if (!socket.data.host) return ack({ ok: false, error: 'Solo el vendedor.' });
        const sala = salas.get(socket.data.liveId);
        if (!sala) return ack({ ok: false, error: 'Sala no cargada.' });
        try { await fn(sala, data, ack); } catch (e) { console.error('[live] host', e); ack({ ok: false, error: 'Error del servidor.' }); }
      };
    }

    socket.on('host:pin', soloHost(async (sala, { idx }, ack) => {
      if (sala.subasta?.timer) return ack({ ok: false, error: 'Cierra la subasta actual primero.' });
      if (!sala.live.items[idx]) return ack({ ok: false, error: 'Producto inválido.' });
      sala.idx = idx;
      sala.subasta = null;
      db.collection('lives').doc(sala.live.id).update({ idxActual: idx }).catch(() => {});
      io.to(sala.live.id).emit('live:item', { idx, stock: sala.stock[idx] });
      ack({ ok: true });
    }));

    socket.on('host:subasta', soloHost(async (sala, { segundos }, ack) => {
      const item = sala.live.items[sala.idx];
      if (item.modo !== 'sub') return ack({ ok: false, error: 'Este producto es de precio fijo.' });
      if (sala.subasta?.timer) return ack({ ok: false, error: 'Ya hay una subasta abierta.' });
      if (sala.stock[sala.idx] <= 0) return ack({ ok: false, error: 'Sin unidades.' });
      const seg = Math.min(300, Math.max(10, Number(segundos) || item.segundos || 45));
      sala.subasta = { idx: sala.idx, bid: item.inicial, lider: null, inicio: now(), finEn: now() + seg * 1000, timer: null, pujas: 0 };
      programarCierre(sala.live.id, sala);
      io.to(sala.live.id).emit('live:subasta', { idx: sala.idx, bid: item.inicial, finEn: sala.subasta.finEn, total: seg });
      sistema(sala.live.id, sala, `⏱️ Subasta abierta: ${item.titulo} desde $${item.inicial}`);
      ack({ ok: true });
    }));

    socket.on('host:cerrar', soloHost(async (sala, _d, ack) => {
      if (!sala.subasta?.timer) return ack({ ok: false, error: 'No hay subasta abierta.' });
      await cerrarSubasta(sala.live.id, sala);
      ack({ ok: true });
    }));

    socket.on('disconnect', () => {
      const { liveId } = socket.data;
      if (liveId) io.to(liveId).emit('live:espectadores', espectadores(liveId));
    });
  });

  // ---------- REST ----------
  const r = express.Router();
  r.use(express.json({ limit: '200kb' }));
  r.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && (origins.includes('*') || origins.includes(o))) {
      res.set('Access-Control-Allow-Origin', o);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-host-key');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const esAdmin = req => ADMIN_KEY && req.get('x-admin-key') === ADMIN_KEY;

  // Lista pública: en vivo ahora + programados
  r.get('/', async (_req, res) => {
    try {
      const snap = await db.collection('lives').where('estado', 'in', ['en_vivo', 'programado']).get();
      const lives = snap.docs.map(d => {
        const live = publico({ id: d.id, ...d.data() });
        if (live.inicio?.toDate) live.inicio = live.inicio.toDate().toISOString();
        if (live.creado?.toDate) live.creado = live.creado.toDate().toISOString();
        return { ...live, espectadores: espectadores(d.id) };
      }).sort((a, b) => (a.estado === b.estado ? String(a.inicio).localeCompare(String(b.inicio)) : a.estado === 'en_vivo' ? -1 : 1));
      res.json({ lives });
    } catch (e) { console.error('[live] list', e); res.status(500).json({ error: 'No se pudo cargar la lista.' }); }
  });

  // Crear en vivo (solo agentes de Equipaya). Devuelve la clave del vendedor UNA sola vez.
  r.post('/', async (req, res) => {
    if (!esAdmin(req)) return res.status(401).json({ error: 'Clave de administrador incorrecta.' });
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map(it => ({
      titulo: limpiar(it.titulo, 120),
      pid: it.pid ?? null,
      modo: it.modo === 'sub' ? 'sub' : 'fijo',
      precio: Number(it.precio) || 0,
      inicial: Number(it.inicial) || 1,
      segundos: Math.min(300, Math.max(10, Number(it.segundos) || 45)),
      stock: Number.isFinite(Number(it.stock)) && it.stock !== '' ? Number(it.stock) : 9999,
      imagen: limpiar(it.imagen, 400),
      art: limpiar(it.art, 20) || 'gondola',
      col: limpiar(it.col, 10) || '#2E7D74'
    })).filter(it => it.titulo);
    if (!limpiar(b.titulo) || !items.length) return res.status(400).json({ error: 'Faltan título o productos.' });
    const hostKey = crypto.randomBytes(12).toString('base64url');
    const doc = {
      titulo: limpiar(b.titulo, 120),
      vendedor: {
        nombre: limpiar(b.vendedor?.nombre, 60) || 'Vendedor',
        negocio: limpiar(b.vendedor?.negocio, 80),
        verificado: true,
        verificadoPor: limpiar(b.vendedor?.verificadoPor, 60)
      },
      estado: 'programado',
      inicio: b.inicio ? new Date(b.inicio) : new Date(),
      videoUrl: limpiar(b.videoUrl, 400),
      fondo: limpiar(b.fondo, 120),
      items,
      idxActual: 0,
      hostKeyHash: sha(hostKey),
      creado: ts()
    };
    const ref = await db.collection('lives').add(doc);
    res.json({ id: ref.id, hostKey });
  });

  // Iniciar / terminar (vendedor con su clave o admin)
  r.post('/:id/estado', async (req, res) => {
    try {
      const ref = db.collection('lives').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'No existe.' });
      const okHost = req.get('x-host-key') && sha(req.get('x-host-key')) === snap.data().hostKeyHash;
      if (!okHost && !esAdmin(req)) return res.status(401).json({ error: 'No autorizado.' });
      const estado = req.body?.estado;
      if (!['en_vivo', 'terminado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
      await ref.update({ estado, [estado === 'en_vivo' ? 'empezo' : 'termino']: ts() });
      const sala = salas.get(req.params.id);
      if (sala) {
        sala.live.estado = estado;
        if (estado === 'terminado') {
          if (sala.subasta?.timer) await cerrarSubasta(req.params.id, sala);
          io.to(req.params.id).emit('live:fin');
          salas.delete(req.params.id);
        }
      }
      res.json({ ok: true });
    } catch (e) { console.error('[live] estado', e); res.status(500).json({ error: 'Error del servidor.' }); }
  });

  // Pedidos con pago retenido (solo admin)
  r.get('/pedidos', async (req, res) => {
    if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado.' });
    const q = db.collection('pedidos_live');
    const snap = await (req.query.estado ? q.where('estado', '==', String(req.query.estado)) : q).limit(200).get();
    res.json({ pedidos: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  });

  r.patch('/pedidos/:id', async (req, res) => {
    if (!esAdmin(req)) return res.status(401).json({ error: 'No autorizado.' });
    const nuevo = req.body?.estado;
    const ref = db.collection('pedidos_live').doc(req.params.id);
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('No existe.'), { code: 404 });
        const actual = snap.data().estado;
        if (!(ESTADOS_PEDIDO[actual] || []).includes(nuevo)) {
          throw Object.assign(new Error(`No se puede pasar de "${actual}" a "${nuevo}".`), { code: 400 });
        }
        const historial = [...(snap.data().historial || []), { estado: nuevo, en: new Date().toISOString(), nota: limpiar(req.body?.nota, 200) }];
        tx.update(ref, { estado: nuevo, historial });
      });
      res.json({ ok: true });
    } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  app.use('/live', r);
  console.log('[live] Ventas en vivo listas en /live y /socket.io');
  return io;
};

module.exports.ESTADOS_PEDIDO = ESTADOS_PEDIDO;

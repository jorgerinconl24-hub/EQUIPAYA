// Prueba de punta a punta de live.js con un Firestore simulado en memoria.
const http = require('http');
const express = require('express');
const { io: cio } = require('socket.io-client');
const assert = require('assert');

// ---- Firestore simulado ----
let auto = 0;
const store = new Map(); // path -> data
function docRef(path) {
  return {
    id: path.split('/').pop(),
    async get() { const d = store.get(path); return { id: path.split('/').pop(), exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; },
    async update(u) { store.set(path, { ...store.get(path), ...u }); },
    collection: n => colRef(path + '/' + n)
  };
}
function colRef(path, filters = []) {
  const docs = () => [...store.entries()].filter(([k]) => k.startsWith(path + '/') && k.slice(path.length + 1).indexOf('/') === -1)
    .map(([k, v]) => ({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(v)), v }))
    .filter(d => filters.every(([f, op, val]) => op === 'in' ? val.includes(d.v[f]) : d.v[f] === val));
  return {
    doc: id => docRef(path + '/' + id),
    async add(d) { const id = 'id' + (++auto); store.set(path + '/' + id, d); return { id }; },
    where: (f, op, v) => colRef(path, [...filters, [f, op, v]]),
    limit: () => colRef(path, filters),
    async get() { return { docs: docs() }; }
  };
}
const db = {
  collection: n => colRef(n),
  async runTransaction(fn) { return fn({ get: r => r.get(), update: (r, u) => r.update(u) }); }
};

process.env.LIVE_ADMIN_KEY = 'adm';
const app = express();
const server = http.createServer(app);
require('./live.js')({ server, app, db, admin: null, express });

const wait = ms => new Promise(r => setTimeout(r, ms));
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const conectar = url => new Promise(r => { const s = cio(url, { transports: ['websocket'] }); s.on('connect', () => r(s)); });

server.listen(0, async () => {
  const url = 'http://localhost:' + server.address().port;
  const j = (p, o = {}) => fetch(url + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } }).then(async r => ({ s: r.status, b: await r.json() }));
  try {
    // 1. crear (sin clave → 401, con clave → ok)
    assert.equal((await j('/live', { method: 'POST', body: '{}' })).s, 401);
    const c = await j('/live', { method: 'POST', headers: { 'x-admin-key': 'adm' }, body: JSON.stringify({
      titulo: 'Góndolas de fábrica', vendedor: { nombre: 'Mobiliario Zulia', negocio: 'Maracaibo' },
      items: [{ titulo: 'Góndola 1.20', modo: 'sub', inicial: 99, segundos: 12, stock: 2 }, { titulo: 'Estante 5 niveles', modo: 'fijo', precio: 79, stock: 1 }] }) });
    assert.equal(c.s, 200); const { id, hostKey } = c.b;
    console.log('✓ crear en vivo', id);

    // 2. lista pública sin hostKeyHash
    const l = await j('/live'); assert.equal(l.b.lives.length, 1); assert(!('hostKeyHash' in l.b.lives[0]));
    console.log('✓ lista pública oculta la clave');

    // 3. comprador no entra si no ha empezado
    const A = await conectar(url);
    let r = await emit(A, 'live:join', { liveId: id, user: { id: 'a', nombre: 'Ana', tel: '04141111111' } });
    assert.equal(r.ok, false); console.log('✓ bloquea entrar antes de empezar:', r.error);

    // 4. host con clave mala / buena, iniciar
    const H = await conectar(url);
    assert.equal((await emit(H, 'host:join', { liveId: id, hostKey: 'mala' })).ok, false);
    assert.equal((await emit(H, 'host:join', { liveId: id, hostKey })).ok, true);
    assert.equal((await j(`/live/${id}/estado`, { method: 'POST', headers: { 'x-host-key': hostKey }, body: '{"estado":"en_vivo"}' })).s, 200);
    console.log('✓ vendedor autenticado e inició');

    // 5. compradores entran
    r = await emit(A, 'live:join', { liveId: id, user: { id: 'a', nombre: 'Ana', tel: '04141111111' } }); assert(r.ok);
    const B = await conectar(url);
    r = await emit(B, 'live:join', { liveId: id, user: { id: 'b', nombre: 'Beto', tel: '04242222222' } }); assert(r.ok);
    const Csin = await conectar(url);
    await emit(Csin, 'live:join', { liveId: id, user: { id: 'c', nombre: 'SinTel' } });
    const resultados = []; A.on('live:resultado', x => resultados.push(x));
    console.log('✓ 3 compradores dentro');

    // 6. chat llega a todos y se limpia HTML
    const llego = new Promise(res => B.once('live:chat', res));
    A.emit('live:chat', { texto: '<b>hola</b>' });
    const m = await llego; assert.equal(m.texto, 'bhola/b'); console.log('✓ chat en tiempo real, sin HTML');

    // 7. pujar sin subasta abierta → error; abrir subasta
    assert.equal((await emit(A, 'live:bid', { monto: 100 })).ok, false);
    assert.equal((await emit(A, 'host:subasta', { segundos: 12 })).ok, false); // comprador no puede abrir
    assert.equal((await emit(H, 'host:subasta', { segundos: 12 })).ok, true);
    console.log('✓ solo el vendedor abre la subasta');

    // 8. reglas de puja
    assert.equal((await emit(Csin, 'live:bid', { monto: 99 })).ok, false); // sin teléfono
    assert.equal((await emit(A, 'live:bid', { monto: 98 })).ok, false);    // debajo del inicial
    assert.equal((await emit(A, 'live:bid', { monto: 99 })).ok, true);     // primera puja = inicial
    r = await emit(B, 'live:bid', { monto: 100 }); assert.equal(r.ok, false); assert.equal(r.minimo, 104); // incremento mínimo $5
    assert.equal((await emit(B, 'live:bid', { monto: 104 })).ok, true);
    assert.equal((await emit(H, 'live:bid', { monto: 500 })).ok, false); // vendedor no puja
    console.log('✓ teléfono obligatorio, inicial e incremento mínimo validados');

    // 9. anti-sniping: puja en los últimos segundos extiende a 10 s
    await wait(9000);
    let fin; const ext = new Promise(res => A.once('live:puja', p => res(p)));
    assert.equal((await emit(A, 'live:bid', { monto: 109 })).ok, true);
    fin = (await ext).finEn; assert(fin - Date.now() > 9000, 'debió extenderse');
    console.log('✓ anti-sniping: extendida a', Math.round((fin - Date.now()) / 1000), 's');

    // 10. cierre automático, ganadora Ana, pedido retenido
    await wait(fin - Date.now() + 600);
    assert.equal(resultados.length, 1); assert.equal(resultados[0].ganador, 'Ana'); assert.equal(resultados[0].monto, 109);
    const ped = store.get('pedidos_live/' + resultados[0].pedidoId);
    assert.equal(ped.estado, 'pendiente_pago'); assert.equal(ped.comprador.tel, '04141111111');
    console.log('✓ cierre automático: gana Ana $109, pedido', resultados[0].pedidoId, 'en pendiente_pago');

    // 11. compra a precio fijo con stock 1
    assert.equal((await emit(H, 'host:pin', { idx: 1 })).ok, true);
    r = await emit(B, 'live:buy', {}); assert(r.ok);
    r = await emit(A, 'live:buy', {}); assert.equal(r.ok, false); assert.equal(r.error, 'Agotado.');
    console.log('✓ precio fijo: Beto compra, Ana ve "Agotado"');

    // 12. flujo de pago retenido
    const pid = resultados[0].pedidoId;
    const patch = (e, k = 'adm') => j('/live/pedidos/' + pid, { method: 'PATCH', headers: { 'x-admin-key': k }, body: JSON.stringify({ estado: e }) });
    assert.equal((await patch('liberado')).s, 400);         // no se puede saltar a liberar
    assert.equal((await patch('pagado_retenido', 'x')).s, 401);
    for (const e of ['pagado_retenido', 'enviado', 'entregado', 'liberado']) assert.equal((await patch(e)).s, 200);
    assert.equal(store.get('pedidos_live/' + pid).historial.length, 5);
    console.log('✓ pago retenido: pendiente → pagado_retenido → enviado → entregado → liberado (no permite saltos)');

    // 13. terminar
    const finP = new Promise(res => A.once('live:fin', res));
    assert.equal((await j(`/live/${id}/estado`, { method: 'POST', headers: { 'x-host-key': hostKey }, body: '{"estado":"terminado"}' })).s, 200);
    await finP; console.log('✓ terminar avisa a todos');

    console.log('\nTODAS LAS PRUEBAS PASARON');
    process.exit(0);
  } catch (e) { console.error('✗ FALLÓ', e); process.exit(1); }
});

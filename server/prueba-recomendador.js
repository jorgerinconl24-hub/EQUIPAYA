// Prueba del recomendador: recomendador.js (tienda) + eventos.js (servidor), con base en memoria.
// Ejecuta: npm run test:reco
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const express = require('express');
const assert = require('assert');
const { memoria } = require('./db');

const db = memoria();
const app = express();
app.use(express.json());
require('./eventos')({ app, db, admin: null, express });
const server = http.createServer(app);

// Tienda simulada: carga recomendador.js como lo haría el navegador
function tienda(base) {
  const store = new Map();
  const win = {
    EQY_SERVER: base,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: (u, o) => fetch(u, o),
    location: { pathname: '/equipaya/index.html' },
    crypto: require('crypto').webcrypto,
    setTimeout, clearTimeout, Blob, JSON, Math, Date
  };
  win.crypto.randomUUID = () => require('crypto').randomUUID();
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'recomendador.js'), 'utf8'), win);
  return win.Eqy;
}

// Catálogo reducido con los mismos departamentos que index.html
const productos = [
  { id: 0, dept: 'mob', title: 'Góndola central doble cara', sold: 1240 },
  { id: 3, dept: 'mob', title: 'Estante metálico 5 niveles', sold: 2310 },
  { id: 6, dept: 'vit', title: 'Vitrina exhibidora de vidrio templado con luz LED', sold: 690 },
  { id: 7, dept: 'vit', title: 'Vitrina mostrador para joyería', sold: 215 },
  { id: 9, dept: 'pis', title: 'Piso SPC tipo madera', sold: 5400 },
  { id: 13, dept: 'ilu', title: 'Panel LED 60×60 cm', sold: 4100 },
  { id: 14, dept: 'ilu', title: 'Riel con 4 focos LED para vitrinas', sold: 1320 },
  { id: 17, dept: 'rev', title: 'Panel WPC ranurado', sold: 8800 },
  { id: 21, dept: 'equ', title: 'Nevera exhibidora 2 puertas', sold: 212 },
  { id: 28, dept: 'pos', title: 'Lector de código de barras', sold: 2780 },
  { id: 29, dept: 'sum', title: 'Papel térmico 80×80', sold: 6100 },
  { id: 34, dept: 'mod', title: 'Rack de ropa doble barra', sold: 1430 },
  { id: 35, dept: 'mod', title: 'Maniquí de exhibición', sold: 410 }
];
const pos = (lista, id) => lista.findIndex(p => p.id === id);
const wait = ms => new Promise(r => setTimeout(r, ms));

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  try {
    // 1. Cliente nuevo: ordena por popularidad general
    const nuevo = tienda(base);
    const orden0 = nuevo.ordenar(productos);
    assert.strictEqual(orden0.length, productos.length, 'no pierde productos');
    assert(pos(orden0, 35) >= 4, 'lo poco vendido no sale en el top 4 de un cliente nuevo');
    assert(orden0.slice(0, 4).every(p => p.sold >= 1000), 'arriba van los más vendidos: ' + orden0.slice(0, 4).map(p => p.sold));
    assert(nuevo.debePreguntar(), 'pregunta el tipo de negocio');
    console.log('✓ cliente nuevo: popularidad general');

    // 2. Farmacia: vitrinas, mobiliario e iluminación arriba; moda abajo
    nuevo.fijarNegocio('farmacia', 'pregunta');
    const ordenF = nuevo.ordenar(productos);
    assert(pos(ordenF, 6) < 5, 'vitrina en el top 5 de una farmacia');
    const farm = ['vit', 'mob', 'ilu', 'pos'];
    assert(ordenF.slice(0, 7).every(p => farm.includes(p.dept)), 'primero todo lo de farmacia: ' + ordenF.map(p => p.dept));
    assert(pos(ordenF, 35) >= 7 && pos(ordenF, 34) >= 7, 'moda después de lo de farmacia');
    assert(!nuevo.debePreguntar(), 'ya no pregunta');
    console.log('✓ farmacia: ' + ordenF.slice(0, 5).map(p => p.dept).join(', '));

    // 3. Un filtro no pisa lo que eligió a propósito
    nuevo.registrar('filtrar_negocio', { negocio: 'boutique' });
    assert.strictEqual(nuevo.negocio(), 'farmacia');
    console.log('✓ un filtro no cambia el negocio elegido');

    // 4. Lo mira mucho tiempo y lo agrega: sube; complementos (iluminación) suben; el producto en el carrito baja
    nuevo.registrar('ver_producto', { pid: 7, dept: 'vit' });
    nuevo.registrar('tiempo_ficha', { pid: 7, dept: 'vit', seg: 40 });
    const antes = nuevo.explicar(productos.find(p => p.id === 14)).total;
    nuevo.registrar('agregar_carrito', { pid: 7, dept: 'vit', qty: 2 });
    nuevo.ordenar(productos); // registra departamentos
    const despues = nuevo.explicar(productos.find(p => p.id === 14));
    assert(despues.total > antes, 'el riel de iluminación sube al tener una vitrina en el carrito');
    assert(despues.detalle.complemento > 0, 'cuenta como complemento');
    const vit7 = nuevo.explicar(productos.find(p => p.id === 7));
    assert(vit7.detalle.enCarrito < 0, 'lo que ya está en el carrito tiene castigo');
    console.log('✓ complementos: riel LED ' + antes.toFixed(2) + ' → ' + despues.total.toFixed(2));

    // 5. Pide por WhatsApp: ese producto baja fuerte
    nuevo.registrar('pedir_whatsapp', { pid: 7, dept: 'vit', qty: 2 });
    const ordenW = nuevo.ordenar(productos);
    assert(pos(ordenW, 7) >= productos.length - 3, 'lo que ya pidió queda al final');
    console.log('✓ lo ya pedido baja al puesto ' + (pos(ordenW, 7) + 1) + ' de ' + productos.length);

    // 6. Fatiga: lo ve muchas veces sin abrirlo y baja
    const f0 = nuevo.explicar(productos.find(p => p.id === 13)).total;
    for (let i = 0; i < 8; i++) nuevo.impresion(13);
    const f1 = nuevo.explicar(productos.find(p => p.id === 13)).total;
    assert(f1 < f0, 'fatiga baja el puntaje');
    console.log('✓ fatiga: panel LED ' + f0.toFixed(2) + ' → ' + f1.toFixed(2));

    // 7. Búsqueda
    nuevo.registrar('buscar', { q: 'papel térmico' });
    assert(nuevo.explicar(productos.find(p => p.id === 29)).detalle.busqueda > 0, 'coincide con la búsqueda');
    console.log('✓ búsqueda suma puntos');

    // 8. Diversidad: no más de 2 seguidos del mismo departamento al inicio
    const div = nuevo.ordenar(productos).slice(0, 6).map(p => p.dept);
    for (let i = 2; i < div.length; i++) assert(!(div[i] === div[i - 1] && div[i] === div[i - 2]), 'mezcla departamentos: ' + div);
    console.log('✓ diversidad: ' + div.join(', '));

    // 9. Envío al servidor y populares por negocio
    nuevo.enviar();
    await wait(300);
    const ev = await db.collection('eventos').get();
    assert(ev.docs.length >= 7, 'eventos guardados: ' + ev.docs.length);
    assert(ev.docs.every(d => d.data().uid && d.data().tipo), 'cada evento tiene uid y tipo');
    console.log('✓ servidor guardó ' + ev.docs.length + ' eventos');

    let pop = await (await fetch(base + '/eventos/populares?negocio=farmacia')).json();
    const p7 = pop.productos.find(p => p.pid === '7');
    assert(p7 && p7.puntos === 4, 'vitrina 7: carrito (1) + WhatsApp (3) = 4 puntos, recibió ' + JSON.stringify(pop));
    console.log('✓ populares de farmacia: ' + JSON.stringify(pop.productos));

    // Repetir la misma acción el mismo día no infla los populares
    const uid = nuevo.perfil().uid;
    await fetch(base + '/eventos', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ eventos: [{ tipo: 'pedir_whatsapp', uid, pid: '7', negocio: 'farmacia', ts: Date.now() }] }) });
    await wait(50);
    // (la caché se borra al sumar, pero aquí no debe sumar)
    pop = await (await fetch(base + '/eventos/populares?negocio=farmacia')).json();
    assert.strictEqual(pop.productos.find(p => p.pid === '7').puntos, 4, 'no cuenta dos veces');
    console.log('✓ no cuenta dos veces la misma acción del mismo cliente');

    // 10. Otro cliente farmacia recibe la vitrina 7 por "negocios como el tuyo"
    const otro = tienda(base);
    otro.fijarNegocio('farmacia', 'pregunta');
    await otro.cargarPopulares();
    const e7 = otro.explicar(productos.find(p => p.id === 7));
    assert(e7.detalle.populares > 0, 'otra farmacia ve la vitrina como popular');
    console.log('✓ otra farmacia: vitrina 7 con +' + e7.detalle.populares + ' por populares');

    // 11. Validaciones del servidor
    let r = await fetch(base + '/eventos', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'no es json' });
    assert.strictEqual(r.status, 400);
    r = await fetch(base + '/eventos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventos: [{ tipo: 'hackear', uid: 'x' }, { tipo: 'ver_producto' }] }) });
    assert.strictEqual((await r.json()).guardados, 0, 'descarta tipos desconocidos y eventos sin uid');
    r = await fetch(base + '/eventos/populares?negocio=../../x');
    assert.strictEqual(r.status, 400);
    console.log('✓ validaciones');

    console.log('\nTodo bien: el recomendador funciona.');
    server.close(); process.exit(0);
  } catch (e) {
    console.error('✗ FALLÓ:', e.message); server.close(); process.exit(1);
  }
});

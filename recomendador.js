/* =====================================================================
   Equipaya — Recomendador (fase 1)
   ---------------------------------------------------------------------
   Qué hace:
   1. Registra lo que hace cada cliente (ve un producto, cuánto tiempo lo
      mira, lo agrega al carrito, pide por WhatsApp, busca, filtra, entra
      a un en vivo, arma su local).
   2. Con eso arma un perfil de gustos en el teléfono del cliente.
   3. Ordena el feed "Recomendado para ti" con reglas y puntajes:
        - tipo de negocio que va a montar (farmacia, bodega...)
        - departamentos y productos que más le interesan (los gustos
          viejos pierden fuerza: vida media de 14 días)
        - complementos de lo que ya tiene en el carrito o pidió
        - lo que más piden otros negocios como el suyo (servidor)
        - popularidad general del producto (para clientes nuevos)
        - baja lo que ya pidió y lo que ve muchas veces sin abrir
        - mezcla departamentos para que el feed no sea repetitivo
   4. Envía los eventos al servidor (/eventos) para guardarlos en
      Firestore: esa data es la base de la fase 2 y la fase 3.

   Uso desde la página:
     Eqy.registrar('ver_producto', {pid: 3, dept: 'mob'})
     Eqy.ordenar(listaDeProductos)   -> lista ordenada
     Eqy.negocio()                    -> 'farmacia' | null
     Eqy.fijarNegocio('farmacia', 'pregunta')
     Eqy.explicar(producto)           -> por qué sale donde sale (consola)
   ===================================================================== */
(function (global) {
  'use strict';

  /* ---------------- CONFIGURACIÓN (ajústala con tu experiencia) ---------------- */
  var SERVIDOR = global.EQY_SERVER || 'https://equipaya-server.onrender.com';
  var VIDA_MEDIA_DIAS = 14;          // en 14 días un interés pesa la mitad
  var CLAVE = 'eqy_gustos';
  var CLAVE_COLA = 'eqy_eventos_cola';

  // Cuánto suma cada acción al interés en el producto y en su departamento.
  var PESOS = {
    ver_producto: 1,
    tiempo_ficha: 0,      // se calcula según los segundos (ver abajo)
    agregar_carrito: 5,
    comprar_ahora: 3,     // se suma encima de agregar_carrito
    pedir_whatsapp: 8,    // la señal más fuerte: pidió cotización
    quitar_carrito: -2,
    filtrar_depto: 1.5,
    buscar: 1,
    ver_live: 1,
    local_armado: 2
  };

  // Qué departamentos necesita cada negocio, del más al menos importante.
  // Usa las mismas claves que local.html.
  var NEGOCIOS = {
    bodega:     { nom: 'Bodega',       deptos: ['mob', 'equ', 'pos', 'sum', 'sen'] },
    super:      { nom: 'Supermercado', deptos: ['mob', 'equ', 'pos', 'pis', 'ilu'] },
    farmacia:   { nom: 'Farmacia',     deptos: ['vit', 'mob', 'ilu', 'pos'] },
    boutique:   { nom: 'Boutique',     deptos: ['mod', 'rev', 'ilu', 'vit'] },
    panaderia:  { nom: 'Panadería',    deptos: ['vit', 'equ', 'pos', 'sum'] },
    ferreteria: { nom: 'Ferretería',   deptos: ['mob', 'pos', 'sen', 'pis'] }
  };

  // Si ya tiene algo de un departamento, qué otros departamentos le completan el local.
  var COMPLEMENTOS = {
    mob: ['ilu', 'sen', 'sum', 'pos'],
    vit: ['ilu', 'rev', 'pos'],
    pis: ['rev', 'ilu'],
    ilu: ['rev', 'vit', 'pis'],
    rev: ['ilu', 'pis', 'mod'],
    equ: ['mob', 'pos', 'sum'],
    pos: ['sum', 'sen', 'mob'],
    sum: ['pos', 'sen'],
    sen: ['ilu', 'sum'],
    mod: ['rev', 'ilu', 'vit']
  };

  // Departamentos que se compran una y otra vez (papel, bolsas...): no se esconden después de pedirlos.
  var RECURRENTES = ['sum'];

  // Peso de cada componente en el puntaje final.
  var W = {
    negocio: 2.2,        // encaja con su tipo de negocio
    depto: 2.0,          // le interesa ese departamento
    producto: 1.2,       // le interesó ese producto en particular
    complemento: 1.5,    // completa lo que ya tiene
    busqueda: 1.2,       // coincide con lo que buscó
    populares: 1.5,      // lo piden negocios como el suyo
    popularidad: 1.2,    // vendido en general
    yaPedido: -5,        // ya lo pidió por WhatsApp (un mueble no se compra dos veces seguidas)
    yaPedidoRecurrente: -0.5, // suministros: los vuelve a comprar, casi no se castiga
    enCarrito: -1.5,     // ya está en su carrito
    fatiga: -0.35,       // por cada vez que lo vio sin abrirlo (después de 3)
    fatigaMax: -2,
    azar: 0.3,           // un poco de variedad entre sesiones
    repetirDepto: -0.9   // castigo por seguir mostrando el mismo departamento
  };

  /* ---------------- ALMACENAMIENTO ---------------- */
  function leer(k, def) { try { var v = JSON.parse(global.localStorage.getItem(k) || 'null'); return v == null ? def : v; } catch (e) { return def; } }
  function escribir(k, v) { try { global.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function ahora() { return Date.now(); }
  function idNuevo() { return (global.crypto && global.crypto.randomUUID) ? global.crypto.randomUUID() : 'u' + Math.random().toString(36).slice(2) + ahora().toString(36); }

  function perfilVacio() {
    return { v: 1, uid: null, negocio: null, negocioFuente: null, omitido: 0,
      prod: {}, dep: {}, busq: [], pedidos: {}, carrito: {}, imp: {}, pop: null };
  }
  var P = leer(CLAVE, null);
  if (!P || P.v !== 1) P = perfilVacio();
  // El mismo id que usa la tienda para el comprador (eqy_me), si existe.
  var me = leer('eqy_me', null);
  if (me && me.id) P.uid = me.id;
  if (!P.uid) P.uid = idNuevo();
  var SESION = idNuevo();
  var semilla = Math.floor(Math.random() * 1e9);
  function guardar() { escribir(CLAVE, P); }
  guardar();

  /* ---------------- PUNTAJES CON DECAIMIENTO ---------------- */
  var LN2 = Math.log(2), VIDA_MS = VIDA_MEDIA_DIAS * 864e5;
  function valor(x) { return x ? x.s * Math.exp(-LN2 * (ahora() - x.t) / VIDA_MS) : 0; }
  function sumar(mapa, clave, n) {
    if (clave == null || !n) return;
    var k = String(clave), act = valor(mapa[k]) + n;
    mapa[k] = { s: Math.max(act, -10), t: ahora() };
  }

  /* ---------------- REGISTRO DE EVENTOS ---------------- */
  var TIPOS = ['ver_producto', 'tiempo_ficha', 'agregar_carrito', 'comprar_ahora', 'pedir_whatsapp',
    'quitar_carrito', 'buscar', 'filtrar_depto', 'filtrar_negocio', 'elegir_negocio', 'ver_live', 'local_armado'];

  function registrar(tipo, d) {
    d = d || {};
    if (TIPOS.indexOf(tipo) < 0) return;
    var pid = d.pid != null ? String(d.pid) : null;
    var dept = d.dept || null;
    var peso = PESOS[tipo] || 0;

    switch (tipo) {
      case 'tiempo_ficha':
        // 2 s = casi nada, 10 s = interés, 30 s o más = mucho interés (tope 3)
        peso = Math.min((+d.seg || 0) / 10, 3);
        break;
      case 'agregar_carrito':
        if (pid) P.carrito[pid] = ahora();
        delete P.imp[pid];
        break;
      case 'quitar_carrito':
        if (pid) delete P.carrito[pid];
        break;
      case 'pedir_whatsapp':
        if (pid) { P.pedidos[pid] = ahora(); delete P.carrito[pid]; }
        break;
      case 'ver_producto':
        delete P.imp[pid];
        break;
      case 'buscar':
        var q = String(d.q || '').toLowerCase().trim().slice(0, 60);
        if (q) { P.busq = [{ q: q, t: ahora() }].concat(P.busq.filter(function (b) { return b.q !== q; })).slice(0, 8); }
        break;
      case 'filtrar_negocio':
        if (d.negocio && !P.negocio) fijarNegocio(d.negocio, 'filtro', true);
        break;
      case 'elegir_negocio':
        break;
      case 'local_armado':
        if (d.negocio) fijarNegocio(d.negocio, 'local', true);
        break;
    }

    if (pid && peso) sumar(P.prod, pid, peso);
    if (dept && peso) sumar(P.dep, dept, tipo === 'filtrar_depto' ? peso : peso * 0.6);
    if (d.deptos && d.deptos.length) d.deptos.forEach(function (x) { sumar(P.dep, x, peso * 0.5); });
    guardar();

    encolar({ tipo: tipo, pid: pid, dept: dept, negocio: d.negocio || P.negocio || null,
      q: d.q ? String(d.q).slice(0, 60) : undefined, seg: d.seg != null ? Math.round(+d.seg) : undefined,
      qty: d.qty != null ? +d.qty : undefined, live: d.live ? String(d.live).slice(0, 40) : undefined,
      area: d.area != null ? Math.round(+d.area) : undefined });
  }

  // Impresiones: cuántas veces vio la tarjeta sin abrirla (solo en el teléfono, no se envían).
  function impresion(pid) {
    if (pid == null) return;
    var k = String(pid); P.imp[k] = (P.imp[k] || 0) + 1;
    clearTimeout(impresion._t); impresion._t = setTimeout(guardar, 800);
  }

  /* ---------------- TIPO DE NEGOCIO ---------------- */
  var FUERZA = { filtro: 1, pregunta: 2, local: 3 };
  function fijarNegocio(clave, fuente, interno) {
    if (!NEGOCIOS[clave]) return;
    fuente = fuente || 'pregunta';
    // Un filtro no pisa lo que el cliente eligió a propósito.
    if (P.negocio && FUERZA[P.negocioFuente] > FUERZA[fuente]) return;
    var cambio = P.negocio !== clave;
    P.negocio = clave; P.negocioFuente = fuente; guardar();
    if (cambio) { P.pop = null; cargarPopulares(); }
    if (!interno) registrar('elegir_negocio', { negocio: clave });
  }
  function omitirNegocio() { P.omitido = ahora(); guardar(); }
  function debePreguntar() { return !P.negocio && ahora() - (P.omitido || 0) > 7 * 864e5; }

  /* ---------------- POPULARES POR NEGOCIO (servidor) ---------------- */
  function cargarPopulares() {
    if (!P.negocio || !global.fetch) return Promise.resolve();
    if (P.pop && P.pop.negocio === P.negocio && ahora() - P.pop.t < 6 * 36e5) return Promise.resolve();
    var neg = P.negocio;
    return global.fetch(SERVIDOR + '/eventos/populares?negocio=' + encodeURIComponent(neg))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.productos || P.negocio !== neg) return;
        var max = 0, m = {};
        j.productos.forEach(function (x) { m[String(x.pid)] = x.puntos; if (x.puntos > max) max = x.puntos; });
        P.pop = { negocio: neg, t: ahora(), max: max, m: m }; guardar();
      })
      .catch(function () {});
  }

  /* ---------------- ENVÍO AL SERVIDOR ---------------- */
  var cola = leer(CLAVE_COLA, []);
  function encolar(e) {
    e.ts = ahora(); e.uid = P.uid; e.sid = SESION;
    e.pagina = (global.location && global.location.pathname || '').split('/').pop() || 'index.html';
    Object.keys(e).forEach(function (k) { if (e[k] === undefined || e[k] === null) delete e[k]; });
    cola.push(e); if (cola.length > 200) cola = cola.slice(-200);
    escribir(CLAVE_COLA, cola);
    clearTimeout(encolar._t); encolar._t = setTimeout(enviar, 8000);
    if (cola.length >= 20) enviar();
  }
  function enviar(alSalir) {
    if (!cola.length) return;
    var lote = cola.slice(0, 50);
    // text/plain para que el navegador no haga la consulta previa de CORS
    var cuerpo = JSON.stringify({ eventos: lote });
    var ok = false;
    if (alSalir && global.navigator && global.navigator.sendBeacon) {
      try { ok = global.navigator.sendBeacon(SERVIDOR + '/eventos', new Blob([cuerpo], { type: 'text/plain' })); } catch (e) {}
      if (ok) { cola = cola.slice(lote.length); escribir(CLAVE_COLA, cola); }
      return;
    }
    if (!global.fetch) return;
    global.fetch(SERVIDOR + '/eventos', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: cuerpo, keepalive: true })
      .then(function (r) {
        if (r.ok || r.status === 400) { cola = cola.slice(lote.length); escribir(CLAVE_COLA, cola); if (cola.length) setTimeout(enviar, 500); }
      })
      .catch(function () {}); // sin conexión: se reintenta en el próximo envío
  }
  if (global.document) {
    global.document.addEventListener('visibilitychange', function () { if (global.document.visibilityState === 'hidden') enviar(true); });
    global.addEventListener && global.addEventListener('pagehide', function () { enviar(true); });
  }

  /* ---------------- RANKING ---------------- */
  function azar(pid) { // número estable por sesión y producto, entre 0 y 1
    var h = semilla ^ (String(pid).split('').reduce(function (a, c) { return (a * 31 + c.charCodeAt(0)) | 0; }, 7));
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function contexto() {
    var depMax = 0, prodMax = 0, k;
    for (k in P.dep) depMax = Math.max(depMax, valor(P.dep[k]));
    for (k in P.prod) prodMax = Math.max(prodMax, valor(P.prod[k]));
    return { depMax: depMax || 1, prodMax: prodMax || 1 };
  }
  var deptosDe = {}; // pid -> dept, lo llena ordenar()
  function complementosActivos() {
    var c = {};
    Object.keys(P.carrito).concat(Object.keys(P.pedidos)).forEach(function (pid) {
      var d = deptosDe[pid]; if (!d) return;
      (COMPLEMENTOS[d] || []).forEach(function (x, i) { c[x] = Math.max(c[x] || 0, 1 - i * 0.2); });
    });
    return c;
  }

  function puntaje(p, ctx, comp) {
    var pid = String(p.id), r = {};
    var neg = P.negocio && NEGOCIOS[P.negocio];
    if (neg) { var i = neg.deptos.indexOf(p.dept); r.negocio = i < 0 ? -0.3 : W.negocio * (1 - i * 0.15); }
    var vd = valor(P.dep[p.dept]); if (vd) r.depto = W.depto * Math.max(-1, vd / ctx.depMax);
    // Si ya lo pidió, su interés en ESE producto ya se cumplió (el del departamento sigue contando).
    var vp = valor(P.prod[pid]); if (vp && !P.pedidos[pid]) r.producto = W.producto * Math.max(-1, vp / ctx.prodMax);
    if (comp[p.dept] && !P.carrito[pid] && !P.pedidos[pid]) r.complemento = W.complemento * comp[p.dept];
    if (P.busq.length) {
      var texto = String(p.title || '').toLowerCase(), b = 0;
      P.busq.forEach(function (s, j) {
        var pal = s.q.split(/\s+/).filter(function (w) { return w.length > 2; });
        if (pal.length && pal.some(function (w) { return texto.indexOf(w) >= 0; })) b = Math.max(b, 1 - j * 0.15);
      });
      if (b) r.busqueda = W.busqueda * b;
    }
    if (P.pop && P.pop.negocio === P.negocio && P.pop.m[pid]) r.populares = W.populares * (P.pop.m[pid] / (P.pop.max || 1));
    if (p.sold) r.popularidad = W.popularidad * Math.min(1, Math.log(1 + p.sold) / Math.log(10000));
    if (P.pedidos[pid]) r.yaPedido = RECURRENTES.indexOf(p.dept) >= 0 ? W.yaPedidoRecurrente : W.yaPedido;
    else if (P.carrito[pid]) r.enCarrito = W.enCarrito;
    var imp = P.imp[pid] || 0; if (imp > 3) r.fatiga = Math.max(W.fatigaMax, W.fatiga * (imp - 3));
    r.azar = W.azar * azar(pid);
    var total = 0; for (var k in r) total += r[k];
    return { total: total, detalle: r };
  }

  // Ordena una lista de productos ({id, dept, title, sold}) para este cliente.
  function ordenar(lista) {
    lista.forEach(function (p) { deptosDe[String(p.id)] = p.dept; });
    var ctx = contexto(), comp = complementosActivos();
    var conPuntaje = lista.map(function (p) { return { p: p, s: puntaje(p, ctx, comp).total }; });
    conPuntaje.sort(function (a, b) { return b.s - a.s; });
    // Diversidad: evita que salgan muchos seguidos del mismo departamento.
    var res = [], resto = conPuntaje.slice();
    while (resto.length) {
      var ult = res.slice(-4), mejor = 0, mejorS = -Infinity;
      for (var i = 0; i < Math.min(resto.length, 12); i++) {
        var rep = ult.filter(function (x) { return x.dept === resto[i].p.dept; }).length;
        var s = resto[i].s + W.repetirDepto * rep;
        if (s > mejorS) { mejorS = s; mejor = i; }
      }
      res.push(resto.splice(mejor, 1)[0].p);
    }
    return res;
  }

  function explicar(p) {
    deptosDe[String(p.id)] = p.dept;
    var x = puntaje(p, contexto(), complementosActivos());
    var d = {}; for (var k in x.detalle) d[k] = Math.round(x.detalle[k] * 100) / 100;
    return { producto: p.title, total: Math.round(x.total * 100) / 100, detalle: d };
  }

  function borrarPerfil() { var uid = P.uid; P = perfilVacio(); P.uid = uid; guardar(); }

  if (P.negocio) cargarPopulares();

  global.Eqy = {
    registrar: registrar,
    impresion: impresion,
    ordenar: ordenar,
    explicar: explicar,
    negocio: function () { return P.negocio; },
    nombreNegocio: function (k) { var n = NEGOCIOS[k || P.negocio]; return n ? n.nom : ''; },
    negocios: function () { return Object.keys(NEGOCIOS).map(function (k) { return { clave: k, nom: NEGOCIOS[k].nom }; }); },
    fijarNegocio: fijarNegocio,
    omitirNegocio: omitirNegocio,
    debePreguntar: debePreguntar,
    cargarPopulares: cargarPopulares,
    enviar: enviar,
    perfil: function () { return JSON.parse(JSON.stringify(P)); },
    borrarPerfil: borrarPerfil
  };
})(typeof window !== 'undefined' ? window : globalThis);

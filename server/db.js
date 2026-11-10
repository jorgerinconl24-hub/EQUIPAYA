/* Base de datos de Equipaya.
   - En Render: Firestore del proyecto Firebase de Equipaya (variable FIREBASE_SERVICE_ACCOUNT).
   - En tu computadora sin credenciales: base en memoria para probar (se borra al reiniciar). */
'use strict';

function memoria() {
  let auto = 0;
  const store = new Map();
  const copia = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const docRef = path => ({
    id: path.split('/').pop(),
    async get() { const d = store.get(path); return { id: path.split('/').pop(), exists: !!d, data: () => copia(d) }; },
    async update(u) { store.set(path, { ...store.get(path), ...copia(u) }); },
    async set(d) { store.set(path, copia(d)); },
    collection: n => colRef(path + '/' + n)
  });
  const colRef = (path, filtros = [], lim = Infinity) => ({
    doc: id => docRef(path + '/' + id),
    async add(d) { const id = 'm' + (++auto).toString(36) + Date.now().toString(36); store.set(path + '/' + id, copia(d)); return { id }; },
    where: (f, op, v) => colRef(path, [...filtros, [f, op, v]], lim),
    limit: n => colRef(path, filtros, n),
    async get() {
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
        .filter(([, v]) => filtros.every(([f, op, val]) => op === 'in' ? val.includes(v[f]) : v[f] === val))
        .slice(0, lim)
        .map(([k, v]) => ({ id: k.split('/').pop(), data: () => copia(v) }));
      return { docs };
    }
  });
  return {
    collection: n => colRef(n),
    async runTransaction(fn) { return fn({ get: r => r.get(), update: (r, u) => r.update(u) }); }
  };
}

let db, admin = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  db = admin.firestore();
  console.log('[db] Firestore conectado');
} else if (process.env.NODE_ENV === 'production') {
  throw new Error('Falta FIREBASE_SERVICE_ACCOUNT en las variables de entorno de Render.');
} else {
  db = memoria();
  console.warn('[db] Sin FIREBASE_SERVICE_ACCOUNT: usando base en memoria (solo para pruebas).');
}

module.exports = { db, admin, memoria };

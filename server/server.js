/* Servidor de Equipaya
   - /live y /socket.io   Ventas en vivo (chat, subastas, compras, pagos retenidos)
   - /plano/levantar      Lectura de planos con IA para "Ver tu negocio"
*/
'use strict';

const http = require('http');
const express = require('express');
const { db, admin } = require('./db');
const { levantarLocal } = require('./plano');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));   // los planos en base64 pesan varios MB

app.get('/', (_req, res) => res.json({ ok: true, app: 'Equipaya', hora: new Date().toISOString() }));

app.options('/plano/levantar', levantarLocal);
app.post('/plano/levantar', levantarLocal);

const server = http.createServer(app);
require('./live')({ server, app, db, admin, express });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[equipaya] Servidor escuchando en el puerto ${PORT}`));

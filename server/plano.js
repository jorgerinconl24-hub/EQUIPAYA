/* =====================================================================
   Equipaya — Lectura de planos con IA
   POST /plano/levantar
   Recibe:   { imagen: "<base64 sin encabezado>", mime, altura, notas }
   Devuelve: { paredes:[{pts:[[x,y],...], g}], columnas:[{x,y,an,fo}], altura, notas }
   Requiere: ANTHROPIC_API_KEY
   ===================================================================== */
'use strict';

const MODELO = process.env.PLANO_MODELO || 'claude-sonnet-4-6';

const INSTRUCCIONES = `Eres un delineante técnico. Recibes el plano de un local comercial y devuelves su geometría en coordenadas reales.

REGLA PRINCIPAL: construye la geometría LEYENDO LAS COTAS ESCRITAS en el plano (los números acotados, impresos o a mano). NO midas píxeles ni estimes proporciones visuales. Si una pared está acotada 14.44, ese tramo mide exactamente 14.44.

SISTEMA DE COORDENADAS
- Unidad: metros. Si las cotas están en cm o mm, conviértelas.
- Origen (0,0) en la esquina superior izquierda del local.
- x crece hacia la derecha. y crece hacia ABAJO, tal como se lee el plano.

QUÉ DEVOLVER
- paredes: lista de polilíneas. Cada una es un recorrido continuo de muro.
  El perímetro exterior debe ser una polilínea CERRADA (el último punto igual al primero).
  Las divisiones internas van como polilíneas aparte.
  g = grosor del muro en metros (0.15 si no está indicado; 0.20-0.30 en muros exteriores de bloque).
- columnas: posición del CENTRO de cada columna, con su sección an x fo.
  Si el plano indica ejes cada cierta distancia, genera todas las columnas de la retícula.
- altura: usa la que viene en la petición salvo que el plano indique otra.
- notas: una frase corta en español. Menciona SOLO lo que quedó incierto o lo que
  tuviste que asumir (cotas ilegibles, tramos sin acotar, curvas aproximadas a rectas).
  Si todo estaba claro, devuelve "".

COHERENCIA
- Verifica que las cotas cierren. Si la suma de tramos parciales no coincide con la
  cota total, ajusta el tramo MENOS legible y dilo en notas.
- Si el plano tiene cajetín, membrete o mobiliario existente dibujado, ignóralos.
  Solo interesan muros y columnas.

FORMATO
Devuelve ÚNICAMENTE un objeto JSON válido. Sin explicaciones, sin markdown, sin backticks.

{"paredes":[{"pts":[[0,0],[14.44,0],[14.44,8.2],[0,8.2],[0,0]],"g":0.2}],
 "columnas":[{"x":6.0,"y":4.1,"an":0.4,"fo":0.4}],
 "altura":3.0,
 "notas":""}`;

async function levantarLocal(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'La lectura de planos no está configurada en el servidor' });
  }

  try {
    const { imagen, mime = 'image/png', altura = 3, notas = '' } = req.body || {};
    if (!imagen) return res.status(400).json({ error: 'Falta la imagen del plano' });

    const contexto = [
      `Altura del local indicada por el usuario: ${altura} m.`,
      notas ? `Notas del usuario: ${String(notas).slice(0, 300)}` : ''
    ].filter(Boolean).join(' ');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 8000,
        system: INSTRUCCIONES,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imagen } },
            { type: 'text', text: `${contexto}\n\nLevanta este local. Devuelve solo el JSON.` }
          ]
        }]
      })
    });

    if (!r.ok) {
      console.error('[plano] La IA respondió', r.status, (await r.text()).slice(0, 500));
      return res.status(502).json({ error: 'La IA no respondió correctamente' });
    }

    const data = await r.json();
    const texto = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      .replace(/```json|```/g, '').trim();

    let geo;
    try { geo = JSON.parse(texto); }
    catch {
      const m = texto.match(/\{[\s\S]*\}/);
      if (!m) {
        console.error('[plano] Respuesta no interpretable:', texto.slice(0, 600));
        return res.status(422).json({ error: 'No se pudo interpretar el plano' });
      }
      geo = JSON.parse(m[0]);
    }

    const limpio = validar(geo, altura);
    if (!limpio.paredes.length) return res.status(422).json({ error: 'No se reconocieron paredes acotadas en el plano' });

    console.log(`[plano] Levantado: ${limpio.paredes.length} tramos, ${limpio.columnas.length} columnas`);
    res.json(limpio);
  } catch (err) {
    console.error('[plano] Error:', err);
    res.status(500).json({ error: 'Error interno al procesar el plano' });
  }
}

function validar(geo, alturaPorDefecto) {
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const paredes = (Array.isArray(geo.paredes) ? geo.paredes : [])
    .map(p => {
      const pts = (Array.isArray(p.pts) ? p.pts : [])
        .map(q => (Array.isArray(q) && num(q[0]) !== null && num(q[1]) !== null) ? [q[0], q[1]] : null)
        .filter(Boolean);
      return { pts, g: num(p.g) && p.g > 0 ? p.g : 0.15 };
    })
    .filter(p => p.pts.length >= 2);
  const columnas = (Array.isArray(geo.columnas) ? geo.columnas : [])
    .filter(c => num(c.x) !== null && num(c.y) !== null)
    .map(c => ({ x: c.x, y: c.y, an: num(c.an) && c.an > 0 ? c.an : 0.4, fo: num(c.fo) && c.fo > 0 ? c.fo : 0.4 }));
  return {
    paredes,
    columnas,
    altura: num(geo.altura) && geo.altura >= 2 ? geo.altura : alturaPorDefecto,
    notas: typeof geo.notas === 'string' ? geo.notas.slice(0, 200) : ''
  };
}

module.exports = { levantarLocal, validar };

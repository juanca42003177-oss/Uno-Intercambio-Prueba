// Vigía de Dragon Trade — soporte técnico automático de Juan.
// Un cron externo gratuito (cron-job.org) llama este endpoint cada 5 min.
// Verifica: bodega (GitHub dragon-labs-data), RPC de World Chain (el bot de
// predicciones vive ahí) y fuente de precios (Kraken, para resolver mercados).
// Si algo falla: avisa Telegram (🐉) y despierta al agente vía
// CRYPTO_ALERT_WEBHOOK (solo en el cambio de estado, max 1 recordatorio/6h).
const wrap = require('./_cors');

const APP = 'dragontrade';
const PREFIX = '🐉 Dragon Trade';
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'damas-data';
const VIGIA_PATH = 'notify/vigia-dragon.json';
const RERECORDAR = 6 * 3600 * 1000;
const RPCS = [
  'https://worldchain-mainnet.g.alchemy.com/public',
  'https://worldchain.drpc.org',
];

function gh() { return process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN_2 || ''; }

async function loadFile(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: { Authorization: `token ${gh()}`, Accept: 'application/vnd.github.raw+json' },
  });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error('leer ' + path + ' HTTP ' + r.status);
  const sha = (r.headers.get('etag') || '').replace(/"/g, '') || null;
  let data = null;
  try { data = JSON.parse(await r.text()); } catch (e) { data = null; }
  return { sha, data };
}

async function saveFile(path, sha, data, msg) {
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const body = { message: msg, branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64') };
  if (sha) body.sha = sha;
  const put = await fetch(api, {
    method: 'PUT',
    headers: { Authorization: `token ${gh()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!put.ok) throw new Error('guardar ' + path + ' HTTP ' + put.status);
}

async function aviso(texto) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok) return;
    await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { }
}

async function despertarAgente(payload) {
  try {
    const url = process.env.CRYPTO_ALERT_WEBHOOK;
    if (!url) return false;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return r.ok;
  } catch (e) { return false; }
}

module.exports = wrap(async (req, res) => {
  const now = Date.now();

  // PRUEBA de la cadena (?test=1): despierta al agente sin marcar falla
  if ((req.query || {}).test === '1') {
    const problemas = ['PRUEBA de la cadena de soporte: verificá que Dragon Trade responda y avisale a Juan que todo funciona.'];
    const enviado = await despertarAgente({ app: APP, tipo: 'test', problemas, detalle: 'PRUEBA de Juan en Dragon Trade. Si leés esto, confirmá que la app y el bot de predicciones responden bien y avisale.', ts: Date.now() });
    await aviso(PREFIX + ': PRUEBA de la cadena de soporte disparada' + (enviado ? ' — agente despertado.' : ' — agente NO despertado: falta la variable CRYPTO_ALERT_WEBHOOK en Vercel.'));
    let host = '';
    try { host = new URL(process.env.CRYPTO_ALERT_WEBHOOK || '').hostname; } catch (e) { host = 'URL_INVALIDA'; }
    return res.status(200).json({ ok: true, prueba: 'disparada', agenteDespertado: enviado, urlApuntaA: host });
  }

  const problemas = [];

  // 1) bodega viva (subs y volumenes del bot)
  try {
    const f = await loadFile('notify/subs-dragon.json');
    if (!f || !f.data || !Array.isArray(f.data.subs)) problemas.push('bodega (subs-dragon.json en rama damas-data) no responde');
  } catch (e) { problemas.push('bodega falló: ' + String(e.message || e)); }

  // 2) RPC de World Chain: el bot de predicciones firma en cadena, sin RPC no resuelve mercados
  let rpcOk = false;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
      const j = r.ok ? await r.json() : null;
      if (j && j.result) { rpcOk = true; break; }
    } catch (e) { }
  }
  if (!rpcOk) problemas.push('ningún RPC de World Chain responde (el bot no puede resolver mercados)');

  // 3) fuente de precios viva (para resolver mercados con precio de apertura)
  try {
    const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', { headers: { 'User-Agent': 'vigia' } });
    if (!r.ok) problemas.push('fuente de precios (Kraken) responde HTTP ' + r.status);
  } catch (e) { problemas.push('fuente de precios (Kraken) inalcanzable'); }

  const ok = problemas.length === 0;

  // estado con memoria: avisar SOLO en el cambio (y cada 6h si persiste)
  let st = { estado: 'ok', ultimoAviso: 0, desde: now };
  try {
    const f = await loadFile(VIGIA_PATH);
    if (f && f.data && f.data.estado) st = f.data;
  } catch (e) { }
  let cambio = false;
  if (ok && st.estado === 'falla') {
    cambio = true;
    await aviso(PREFIX + ': 🟢 todo volvió a la normalidad. — Vigía');
    st = { estado: 'ok', ultimoAviso: now, desde: st.desde || now };
  } else if (!ok && (st.estado !== 'falla' || now - (st.ultimoAviso || 0) > RERECORDAR)) {
    cambio = true;
    await aviso(PREFIX + ' 🔴 FALLA — Vigía detectó:\n' + problemas.map(p => '• ' + p).join('\n'));
    await despertarAgente({ app: APP, tipo: 'fallo', problemas, detalle: 'Fallo real en Dragon Trade detectado por el Vigía: ' + problemas.join(' | '), ts: now });
    st = { estado: 'falla', ultimoAviso: now, desde: st.estado === 'falla' ? (st.desde || now) : now };
  }
  if (cambio) {
    try {
      const f = await loadFile(VIGIA_PATH);
      await saveFile(VIGIA_PATH, f ? f.sha : null, st, 'vigia dragon: estado ' + st.estado);
    } catch (e) { }
  }

  res.status(ok ? 200 : 503).json({ ok, rpcOk, problemas });
});

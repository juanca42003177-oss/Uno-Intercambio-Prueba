// predictBotTick (Vercel) — BOT AUTOMÁTICO de Predicciones de Dragon Trade.
// Port stateless del backend Base44: ya no usa la base de datos.
//   - Resuelve mercados vencidos: precio de apertura desde el HISTÓRICO de
//     Kraken/Coinbase en (resolveAt - duración) — el plan B que ya tenía el bot.
//   - Capa larga: cada token rota 24h → 72h → 1 semana (WLD, WBTC, ETH, uSOL).
//   - Escanea los últimos 300 mercados en cadena para ver los abiertos
//     (reemplaza el filtro status='open' de la base de datos).
//   - Avisos de Telegram con 🐉 (TELEGRAM_BOT_TOKEN).
// Requiere env vars: PREDICT_BOT_PRIVATE_KEY, TELEGRAM_BOT_TOKEN.
// Ejecutar cada 5-10 min con un cron externo gratis (cron-job.org), porque
// el plan Hobby de Vercel solo permite 1 cron/día.

let secpGetPublicKey, secpSign, secpEtc, hmac, sha256, keccak_256;
var MODULE_LOAD_ERROR = null;
try {
  const s = require('@noble/secp256k1');
  secpGetPublicKey = s.getPublicKey; secpSign = s.sign; secpEtc = s.etc;
  hmac = require('@noble/hashes/hmac').hmac;
  sha256 = require('@noble/hashes/sha256').sha256;
  keccak_256 = require('@noble/hashes/sha3').keccak_256;
} catch (e) { MODULE_LOAD_ERROR = String(e); }

function concatBytes(...arrs) {
  const len = arrs.reduce((x, a) => x + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
secpEtc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, concatBytes(...msgs));

const CHAIN_ID = 480;
const PREDICT_ADDRESS = '0xeb6a656890c9990e685c7a20efe978740fbf9109';
const FEE_GAS_LIMIT = 300000;
const RPC = 'https://worldchain-mainnet.g.alchemy.com/public';

const TOKENS = [
  { sym: 'WLD', source: 'kraken', kraken: 'WLDUSD', coinbase: 'WLD-USD' },
  { sym: 'ETH', source: 'kraken', kraken: 'ETHUSD', coinbase: 'ETH-USD' },
  { sym: 'WBTC', source: 'kraken', kraken: 'XBTUSD', coinbase: 'BTC-USD' },
  { sym: 'uSOL', source: 'kraken', kraken: 'SOLUSD', coinbase: 'SOL-USD' },
  { sym: 'uXRP', source: 'kraken', kraken: 'XRPUSD', coinbase: 'XRP-USD' },
  { sym: 'uDOGE', source: 'kraken', kraken: 'XDGUSD', coinbase: 'DOGE-USD' },
  { sym: 'SUSHI', source: 'kraken', kraken: 'SUSHIUSD', coinbase: 'SUSHI-USD' },
  { sym: 'CHAD', source: 'dexscreener' },
];
const CHAD_ADDRESS = '0x50723A159ba02A1ADA4d7E1A32835f7ff1F1bE89';
const LONG_CYCLE = [86400, 259200, 604800];
const LONG_LABELS = ['24 horas', '72 horas', '1 semana'];
const NEW_MARKET_SYMS = new Set(['WLD', 'WBTC', 'ETH', 'uSOL']);
const FAST_DUR = 600;
const FAST_LABEL = '10 minutos';
const SCAN_WINDOW = 300; // mercados históricos a escanear (reemplaza la base)
const TELEGRAM_CHAT_ID = '8022768138';

const SEL = {
  marketCount: '0xec979082',
  marketSummary: '0xe67298fa',
};

function durFromLabel(label) {
  const m = (label || '').split(' - ').pop().trim().toLowerCase();
  if (m === FAST_LABEL) return FAST_DUR;
  const i = LONG_LABELS.indexOf(m);
  return i >= 0 ? LONG_CYCLE[i] : 0;
}
function longDurFromLabel(label) {
  const m = (label || '').split(' - ').pop().trim().toLowerCase();
  const i = LONG_LABELS.indexOf(m);
  return i >= 0 ? LONG_CYCLE[i] : 0;
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error('RPC ' + method + ': ' + JSON.stringify(j.error));
  return j.result;
}

async function rpcBatch(calls) {
  if (calls.length === 0) return {};
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, method: c.method, params: c.params }))),
  });
  const j = await res.json();
  const out = {};
  for (const r of j) out[r.id] = r.result;
  return out;
}

function hexToBigInt(h) {
  if (!h || h === '0x') return 0n;
  try { return BigInt(h); } catch (e) { return 0n; }
}
function strip(h) { return h.startsWith('0x') ? h.slice(2) : h; }

// ---- Firma de transacciones (EIP-155 legacy) ----
function rlpItem(hexNoPrefix) {
  const b = hexNoPrefix === '' ? '' : (hexNoPrefix.length % 2 ? '0' + hexNoPrefix : hexNoPrefix);
  const bytes = b.length / 2;
  if (bytes === 1 && parseInt(b, 16) < 0x80) return b;
  if (bytes < 56) return (0x80 + bytes).toString(16).padStart(2, '0') + b;
  const lenHex = bytes.toString(16);
  const lenBytes = Math.ceil(lenHex.length / 2);
  const lenPadded = lenHex.padStart(lenBytes * 2, '0');
  return (0xb7 + lenBytes).toString(16) + lenPadded + b;
}
function rlpList(items) {
  const payload = items.join('');
  const bytes = payload.length / 2;
  if (bytes < 56) return (0xc0 + bytes).toString(16).padStart(2, '0') + payload;
  const lenHex = bytes.toString(16);
  const lenBytes = Math.ceil(lenHex.length / 2);
  const lenPadded = lenHex.padStart(lenBytes * 2, '0');
  return (0xf7 + lenBytes).toString(16) + lenPadded + payload;
}
function numHex(n) {
  if (typeof n === 'string') return strip(n);
  const v = BigInt(n);
  if (v === 0n) return '';
  return v.toString(16);
}
function hexBytes(hexNoPrefix) {
  const h = hexNoPrefix.length % 2 ? '0' + hexNoPrefix : hexNoPrefix;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

let _botAddr = '';
function botAddress() {
  if (_botAddr) return _botAddr;
  const env = process.env.PREDICT_BOT_ADDRESS;
  if (env) { _botAddr = env; return _botAddr; }
  const priv = (process.env.PREDICT_BOT_PRIVATE_KEY || '').replace(/^0x/, '').trim();
  const pub = secpGetPublicKey(priv, false);
  const hash = keccak_256(pub.slice(1));
  let addr = '0x';
  for (let i = 12; i < 20; i++) addr += hash[i].toString(16).padStart(2, '0');
  _botAddr = addr;
  return addr;
}

async function sendTx(to, data) {
  const priv = (process.env.PREDICT_BOT_PRIVATE_KEY || '').replace(/^0x/, '').trim();
  if (priv.length !== 64) throw new Error('PREDICT_BOT_PRIVATE_KEY no configurada');

  const nonce = await rpc('eth_getTransactionCount', [botAddress(), 'pending']);
  const gasPrice = await rpc('eth_gasPrice', []);
  let gasLimit = '';
  try {
    gasLimit = await rpc('eth_estimateGas', [{ from: botAddress(), to, data }, 'latest']);
  } catch (e) { gasLimit = '0x' + FEE_GAS_LIMIT.toString(16); }

  const unsigned = rlpList([
    rlpItem(numHex(strip(nonce))),
    rlpItem(numHex(strip(gasPrice))),
    rlpItem(numHex(strip(gasLimit))),
    rlpItem(strip(to).toLowerCase()),
    rlpItem(''),
    rlpItem(strip(data)),
    rlpItem(numHex(CHAIN_ID)),
    rlpItem(''),
    rlpItem(''),
  ]);
  const msgHash = keccak_256(hexBytes(unsigned));
  const sig = secpSign(msgHash, priv);
  const v = 35 + 2 * CHAIN_ID + Number(sig.recovery);
  const signed = rlpList([
    rlpItem(numHex(strip(nonce))),
    rlpItem(numHex(strip(gasPrice))),
    rlpItem(numHex(strip(gasLimit))),
    rlpItem(strip(to).toLowerCase()),
    rlpItem(''),
    rlpItem(strip(data)),
    rlpItem(numHex(v)),
    rlpItem(sig.r.toString(16).padStart(64, '0')),
    rlpItem(sig.s.toString(16).padStart(64, '0')),
  ]);
  return await rpc('eth_sendRawTransaction', ['0x' + signed]);
}

function marketIdFromReceipt(rc) {
  if (!rc || !Array.isArray(rc.logs)) return null;
  for (const lg of rc.logs) {
    if (String(lg.address || '').toLowerCase() !== PREDICT_ADDRESS.toLowerCase()) continue;
    if (Array.isArray(lg.topics) && lg.topics.length >= 2) {
      try { return Number(BigInt(lg.topics[1])); } catch (e) { /* seguir */ }
    }
  }
  return null;
}

async function waitReceipt(hash) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (r && r.transactionHash) return r;
    } catch (e) { /* reintentar */ }
    await new Promise((res2) => setTimeout(res2, 2000));
  }
  return null;
}

// ---- Precios ----
async function krakenPriceAt(pair, ts) {
  const res = await fetch('https://api.kraken.com/0/public/OHLC?pair=' + pair + '&interval=5', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('kraken HTTP ' + res.status);
  const j = await res.json();
  if (j.error && j.error.length) throw new Error('kraken: ' + j.error[0]);
  const key = Object.keys(j.result || {}).find((k) => k !== 'last');
  const candles = key ? j.result[key] : [];
  let best = null;
  for (const c of candles) if (Number(c[0]) <= ts) best = c;
  if (!best) throw new Error('kraken: sin vela para ts ' + ts);
  return parseFloat(String(best[4]));
}

async function coinbasePriceAt(product, ts) {
  const res = await fetch('https://api.exchange.coinbase.com/products/' + product + '/candles?granularity=300', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('coinbase HTTP ' + res.status);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error('coinbase: respuesta invalida');
  let best = null;
  for (const c of j) if (Number(c[0]) <= ts && (!best || Number(c[0]) > Number(best[0]))) best = c;
  if (!best) throw new Error('coinbase: sin vela para ts ' + ts);
  return parseFloat(String(best[4]));
}

async function majorPriceAt(t, ts) {
  try {
    if (t.kraken) return await krakenPriceAt(t.kraken, ts);
  } catch (e) { /* siguiente fuente */ }
  if (t.coinbase) return await coinbasePriceAt(t.coinbase, ts);
  throw new Error('sin fuente de precio disponible');
}

let _chadCache = null;
async function chadPriceFresh() {
  const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + CHAD_ADDRESS, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('dexscreener HTTP ' + res.status);
  const j = await res.json();
  const pairs = (j.pairs || []).filter((p) => p.chainId === 'worldchain');
  if (pairs.length === 0) throw new Error('dexscreener: CHAD sin pares en World Chain');
  pairs.sort((a, b) => (b.liquidity && b.liquidity.usd || 0) - (a.liquidity && a.liquidity.usd || 0));
  const p = parseFloat(pairs[0].priceUsd);
  if (!(p > 0)) throw new Error('dexscreener: CHAD priceUsd invalido');
  return p;
}
async function chadPrice() {
  const now = Date.now();
  if (_chadCache && now - _chadCache.ts < 15000) return _chadCache.price;
  try {
    const p = await chadPriceFresh();
    _chadCache = { price: p, ts: now };
    return p;
  } catch (e) {
    await new Promise((res2) => setTimeout(res2, 1500));
    const p = await chadPriceFresh();
    _chadCache = { price: p, ts: now };
    return p;
  }
}

async function priceNow(t) {
  if (t.source === 'dexscreener') return await chadPrice();
  return await majorPriceAt(t, Math.floor(Date.now() / 1000) - 30);
}
async function priceAt(t, ts) {
  if (t.source === 'dexscreener') return await chadPrice();
  return await majorPriceAt(t, ts);
}

// ---- Codificación ----
function encUint(n) { return BigInt(n).toString(16).padStart(64, '0'); }
function encBool(b) { return b ? encUint(1) : encUint(0); }
function encString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const lenHex = BigInt(bytes.length).toString(16).padStart(64, '0');
  let body = '';
  for (const b of bytes) body += b.toString(16).padStart(2, '0');
  const pad = body.length % 64 === 0 ? '' : '0'.repeat(64 - (body.length % 64));
  return lenHex + body + pad;
}
const TX_createMarket = '0x9d104956';
const TX_resolve = '0x52a34b05';

// ---- Lectura de mercados (lotes de 12 con reintento, como el original) ----
function decodeSummary(id, hex) {
  const data = strip(hex || '0x');
  if (data.length < 8 * 64) return null;
  const word = (i) => data.slice(i * 64, i * 64 + 64);
  const off = Number(hexToBigInt('0x' + word(0)));
  const bd = Number(hexToBigInt('0x' + word(1)));
  const ra = Number(hexToBigInt('0x' + word(2)));
  const resolved = hexToBigInt('0x' + word(5)) === 1n;
  const upWon = hexToBigInt('0x' + word(6)) === 1n;
  const strStart = off * 2;
  const strLen = Number(hexToBigInt('0x' + data.slice(strStart, strStart + 64)));
  const strHex = data.slice(strStart + 64, strStart + 64 + strLen * 2);
  let label = '';
  try { label = Buffer.from(hexBytes(strHex)).toString('utf8'); } catch (e) { label = ''; }
  return { id, label, betDeadline: bd, resolveAt: ra, resolved, upWon };
}

async function readMarketsSafe(ids) {
  if (ids.length === 0) return { markets: [], missing: [] };
  const chunks = [];
  for (let i = 0; i < ids.length; i += 12) chunks.push(ids.slice(i, i + 12));
  const res = {};
  for (const chunk of chunks) {
    const calls = chunk.map((m) => ({ id: m, method: 'eth_call', params: [{ to: PREDICT_ADDRESS, data: SEL.marketSummary + encUint(m) }, 'latest'] }));
    let r = await rpcBatch(calls).catch(() => ({}));
    const faltan = chunk.filter((m) => !(m in r));
    if (faltan.length > 0) {
      await new Promise((res2) => setTimeout(res2, 400));
      const retryCalls = faltan.map((m) => ({ id: m, method: 'eth_call', params: [{ to: PREDICT_ADDRESS, data: SEL.marketSummary + encUint(m) }, 'latest'] }));
      const r2 = await rpcBatch(retryCalls).catch(() => ({}));
      r = Object.assign({}, r, r2);
    }
    Object.assign(res, r);
  }
  const out = [];
  const missing = [];
  for (const m of ids) {
    const raw = res[m];
    if (raw === undefined) { missing.push(m); continue; }
    const d = decodeSummary(m, raw || '0x');
    if (d) out.push(d); else missing.push(m);
  }
  return { markets: out, missing };
}

// Sin base de datos: escanea los últimos SCAN_WINDOW mercados de la cadena.
// Si falta CUALQUIER dato, unsafeToCreate=true (mejor no crear duplicados).
async function readMarkets() {
  const count = Number(hexToBigInt(await rpc('eth_call', [{ to: PREDICT_ADDRESS, data: SEL.marketCount }, 'latest'])));
  const from = Math.max(0, count - SCAN_WINDOW);
  const ids = [];
  for (let m = from; m < count; m++) ids.push(m);
  const { markets, missing } = await readMarketsSafe(ids);
  return { markets, unsafeToCreate: missing.length > 0, missing, count };
}

// ---- Telegram ----
async function notifyDragon(text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) { console.error('notifyDragon: TELEGRAM_BOT_TOKEN no configurado'); return; }
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: ('🐉 Dragon Trade\n' + text).slice(0, 500) }),
    });
    if (!res.ok) console.error('notifyDragon: Telegram HTTP ' + res.status);
  } catch (e) { console.error('notifyDragon: ' + String(e)); }
}

// ============================================================
module.exports = async (req, res) => {
  if (MODULE_LOAD_ERROR) {
    return res.status(500).json({ status: 'module_load_error', error: MODULE_LOAD_ERROR });
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const mode = String((body && body.mode) || '').toLowerCase();

  if (mode === 'selftest') {
    try {
      const addr = botAddress();
      const priv = (process.env.PREDICT_BOT_PRIVATE_KEY || '').replace(/^0x/, '').trim();
      const okPriv = priv.length === 64;
      const msgHash = keccak_256(new TextEncoder().encode('dragon-trade-selftest'));
      const sig = okPriv ? secpSign(msgHash, priv) : null;
      return res.status(200).json({
        signing_ok: !!(sig && sig.r),
        bot_address: addr,
        key_saved: okPriv,
        contract: PREDICT_ADDRESS,
      });
    } catch (e) {
      return res.status(500).json({ signing_ok: false, error: String(e) });
    }
  }

  if (mode === 'testnotify') {
    await notifyDragon('Mensaje de prueba \u2014 avisos de Dragon Trade activos \u2705');
    return res.status(200).json({ status: 'ok', notified: true });
  }

  const code = await rpc('eth_getCode', [PREDICT_ADDRESS, 'latest']);
  if (!code || code === '0x' || code === '0x0') return res.status(200).json({ status: 'waiting_deploy' });

  const now = Math.floor(Date.now() / 1000);
  const log = { now, resolved: [], created: [], fastCreated: [], skipped: [], errors: [] };

  try {
    const { markets, unsafeToCreate, missing, count } = await readMarkets();
    if (missing.length > 0) log.errors.push({ reason: 'no se pudieron leer estos IDs de la cadena esta vuelta', ids: missing });

    // ---- 1. RESOLVER vencidos (precio de apertura desde el histórico) ----
    for (const m of markets) {
      if (m.resolved || now < m.resolveAt) continue;
      const sym = (m.label || '').split(' ')[0];
      const tok = TOKENS.find((t) => t.sym === sym);
      if (!tok) { log.skipped.push({ id: m.id, reason: 'token desconocido: ' + sym }); continue; }

      let open = 0;
      let close = 0;
      try {
        open = await priceAt(tok, m.resolveAt - (durFromLabel(m.label) || 86400));
        close = await priceAt(tok, m.resolveAt);
      } catch (e) {
        log.errors.push({ id: m.id, sym, reason: 'precio no disponible al resolver: ' + String(e) });
        continue;
      }
      if (!(open > 0) || !(close > 0)) { log.errors.push({ id: m.id, sym, reason: 'precios no disponibles' }); continue; }

      const upWon = close >= open; // empate o subida = ALZA
      const tx = await sendTx(PREDICT_ADDRESS, TX_resolve + encUint(m.id) + encBool(upWon));
      log.resolved.push({ id: m.id, sym, open, close, upWon, fast: durFromLabel(m.label) === FAST_DUR, tx });
      m.resolved = true;
    }

    const longResolved = log.resolved.filter((r) => !r.fast);
    if (longResolved.length > 0) {
      const lines = longResolved.map((r) =>
        '• ' + r.sym + ': ' + (r.upWon ? '\u25B2 gan\u00F3 ALZA' : '\u25BC gan\u00F3 BAJA') +
        ' (abri\u00F3 $' + r.open.toFixed(4).replace(/\.?0+$/, '') + ', cerr\u00F3 $' + r.close.toFixed(4).replace(/\.?0+$/, '') + ')');
      await notifyDragon('Mercados resueltos:\n' + lines.join('\n'));
    }

    // ---- 2. CAPA LARGA: cada token con su ronda de 24 h / 72 h / 1 semana ----
    for (const t of TOKENS) {
      if (!NEW_MARKET_SYMS.has(t.sym)) continue;
      if (unsafeToCreate) { log.skipped.push({ sym: t.sym, layer: 'larga', reason: 'datos incompletos esta vuelta, se reintenta el proximo tick' }); continue; }
      const mine = markets.filter((m) => (m.label || '').split(' ')[0] === t.sym);
      const openLong = mine.some((m) => !m.resolved && m.resolveAt > now && longDurFromLabel(m.label) > 0);
      if (openLong) continue;

      let pos = -1;
      const longMine = mine.filter((m) => longDurFromLabel(m.label) > 0);
      if (longMine.length > 0) {
        const lastM = longMine.reduce((a, x) => (x.id > a.id ? x : a));
        pos = (LONG_CYCLE.indexOf(longDurFromLabel(lastM.label)) + 1) % LONG_CYCLE.length;
      }
      if (pos < 0) pos = TOKENS.findIndex((x) => x.sym === t.sym) % LONG_CYCLE.length;

      const dur = LONG_CYCLE[pos];
      const durLabel = LONG_LABELS[pos];
      let open = 0;
      try { open = await priceNow(t); } catch (e) { log.errors.push({ sym: t.sym, layer: 'larga', reason: 'precio no disponible: ' + String(e) }); continue; }
      if (!(open > 0)) { log.errors.push({ sym: t.sym, layer: 'larga', reason: 'precio invalido' }); continue; }
      const betGap = Math.min(3600, Math.max(125, Math.floor(dur / 10)));
      const betDeadline = now + dur - betGap;
      const resolveAt = now + dur;
      const label = t.sym + ' sube o baja - ' + durLabel;
      const data = TX_createMarket + encUint(96) + encUint(betDeadline) + encUint(resolveAt) + encString(label);
      const tx = await sendTx(PREDICT_ADDRESS, data);
      const rc = await waitReceipt(tx).catch(() => null);
      if (!rc || Number(rc.status) !== 1) {
        log.errors.push({ sym: t.sym, layer: 'larga', reason: 'createMarket no confirmo on-chain', tx });
        continue;
      }
      const marketId = marketIdFromReceipt(rc);
      if (marketId === null) {
        log.errors.push({ sym: t.sym, layer: 'larga', reason: 'no se pudo leer el marketId del evento', tx });
        continue;
      }
      log.created.push({ id: marketId, sym: t.sym, open, label, durLabel, dur, tx });
    }

    if (log.created.length > 0) {
      const lines = log.created.map((c) =>
        '• ' + c.sym + ' — ' + c.durLabel + ' (apertura $' + c.open.toFixed(4).replace(/\.?0+$/, '') + ')');
      await notifyDragon('Nuevas rondas abiertas:' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + '\u00A1Apuesta en Dragon Trade!');
    }

    return res.status(200).json(Object.assign({ status: 'ok', marketCount: count }, log));
  } catch (e) {
    return res.status(500).json(Object.assign({ status: 'error' }, log, { error: String(e) }));
  }
};

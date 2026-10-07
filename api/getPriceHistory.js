// getPriceHistory — VELAS (OHLC) para los gráficos de los mercados de predicción.
// Port del backend Base44 a Vercel, SIN dependencia de Base44 (sin PriceSnap).
// Cada vela: [t, open, high, low, close] (t en ms).
// Fuentes en orden: Binance klines -> Kraken OHLC -> Coinbase candles -> CoinGecko.
// Caché en memoria de 60 s por símbolo.

const BINANCE_SYMS = {
  WLD: 'WLDUSDT', WETH: 'ETHUSDT', ETH: 'ETHUSDT', WBTC: 'BTCUSDT',
  uSOL: 'SOLUSDT', SUSHI: 'SUSHIUSDT', uDOGE: 'DOGEUSDT', uXRP: 'XRPUSDT',
};
const KRAKEN_PAIRS = {
  WLD: 'WLDUSD', WETH: 'ETHUSD', ETH: 'ETHUSD', WBTC: 'XBTUSD',
  uSOL: 'SOLUSD', uXRP: 'XRPUSD', uDOGE: 'XDGUSD', SUSHI: 'SUSHIUSD',
};
const COINBASE_PAIRS = {
  WLD: 'WLD-USD', WETH: 'ETH-USD', ETH: 'ETH-USD', WBTC: 'BTC-USD',
  uSOL: 'SOL-USD', uXRP: 'XRP-USD', uDOGE: 'DOGE-USD', SUSHI: 'SUSHI-USD',
};
const CG_IDS = {
  WLD: 'worldcoin-wld', WETH: 'weth', ETH: 'weth', USDC: 'usd-coin',
  WBTC: 'wrapped-bitcoin', uSOL: 'solana', SUSHI: 'sushi',
  uDOGE: 'dogecoin', uXRP: 'ripple',
};

const HIST_CACHE_MS = 60 * 1000;
const histCache = {}; // sym -> {data, ts}

async function fetchJsonOnce(url, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) { console.error(`fetch ${url} -> HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) {
    console.error(`fetch ${url} -> ${String(e)}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url) {
  const r1 = await fetchJsonOnce(url);
  if (r1 !== null) return r1;
  await new Promise((ok) => setTimeout(ok, 1800 + Math.floor(Math.random() * 1200)));
  return fetchJsonOnce(url);
}

async function cgCandles(id) {
  const j = await fetchJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=1`);
  const prices = j && Array.isArray(j.prices) ? j.prices : [];
  return prices.map((p) => [p[0], p[1], p[1], p[1], p[1]]);
}

async function binanceCandles(pair) {
  const j = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=5m&limit=288`);
  if (!Array.isArray(j)) return [];
  const out = [];
  for (const k of j) {
    const t = Number(k[0]);
    const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]);
    if (t > 0 && c > 0) out.push([t, o, h, l, c]);
  }
  return out;
}

async function krakenCandles(pair) {
  const j = await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5`);
  if (!j || !j.result || (j.error && j.error.length)) return [];
  const key = Object.keys(j.result).find((k) => k !== 'last');
  if (!key || !Array.isArray(j.result[key])) return [];
  const out = [];
  for (const c of j.result[key]) {
    const t = Number(c[0]);
    const o = parseFloat(c[1]), h = parseFloat(c[2]), l = parseFloat(c[3]), cl = parseFloat(c[4]);
    if (t > 0 && cl > 0) out.push([t * 1000, o, h, l, cl]);
  }
  return out.slice(-288);
}

async function coinbaseCandles(pair) {
  const j = await fetchJson(`https://api.exchange.coinbase.com/products/${pair}/candles?granularity=300`);
  if (!Array.isArray(j)) return [];
  const out = [];
  for (const c of j) {
    // coinbase: [time, low, high, open, close, volume]
    const t = Number(c[0]);
    const l = parseFloat(c[1]), h = parseFloat(c[2]), o = parseFloat(c[3]), cl = parseFloat(c[4]);
    if (t > 0 && cl > 0) out.push([t * 1000, o, h, l, cl]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(-288);
}

module.exports = async (req, res) => {
  const body = req.body || {};
  let sym = String(body.sym || (req.query && req.query.sym) || '').trim();
  if (!sym) return res.status(400).json({ error: 'sym requerido' });

  const cached = histCache[sym];
  if (cached && Date.now() - cached.ts < HIST_CACHE_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  let series = [];
  let source = '';
  try {
    if (BINANCE_SYMS[sym]) {
      series = await binanceCandles(BINANCE_SYMS[sym]);
      source = 'binance';
    }
    if (series.length < 10 && KRAKEN_PAIRS[sym]) {
      const ks = await krakenCandles(KRAKEN_PAIRS[sym]);
      if (ks.length >= 10) { series = ks; source = 'kraken'; }
    }
    if (series.length < 10 && COINBASE_PAIRS[sym]) {
      const cs = await coinbaseCandles(COINBASE_PAIRS[sym]);
      if (cs.length >= 10) { series = cs; source = 'coinbase'; }
    }
    if (series.length < 10 && CG_IDS[sym]) {
      const cg = await cgCandles(CG_IDS[sym]);
      if (cg.length >= 10) { series = cg; source = 'coingecko'; }
    }
  } catch (e) {
    return res.status(500).json({ sym, series: [], error: String(e) });
  }

  const data = { sym, series, source, hasHistory: series.length >= 3, ts: Date.now() };
  histCache[sym] = { data, ts: Date.now() };
  return res.status(200).json(data);
};

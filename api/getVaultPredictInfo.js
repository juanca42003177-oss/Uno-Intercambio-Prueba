// getVaultPredictInfo (Vercel) — bóvedas 30 días + mercados de predicción Dragon Trade.
// Sin Base44: escanea TODOS los mercados del contrato y devuelve los no resueltos
// (así los mercados largos de 72h/1 semana nunca se pierden, igual que hacía
// la base de datos con status='open'). Caché server-side de 60 s.
const { rpcBatch, hexToBigInt, padAddr, padNum } = require('./_rpc');

const VAULTS = [
  { id: 'axo', symA: 'AXO', address: '0xdfFC1AC6b093ba7cA9D3A597965284Ce8F07a927' },
  { id: 'dna', symA: 'DNA', address: '0x5C974862F850Ac7AfCBd47cD6364C7279E3a7557' },
  { id: 'chad', symA: 'CHAD', address: '0x10F7F207E047614800c31cEd877A05978dD51e50' },
  { id: 'axo_old', symA: 'AXO', address: '0x6eE69B57B22DABA89fa407B048477AB7c7aD7D71' },
  { id: 'dna_old', symA: 'DNA', address: '0x185aAda41c13aA76340774f64368d807f8EA08EB' },
  { id: 'chad_old', symA: 'CHAD', address: '0x996a3931fd159D41f8E2428472153A8e768C6106' },
];
const PREDICT_ADDRESS = '0xEB6a656890C9990E685c7A20EfE978740fbF9109';

const SEL = {
  minDeposit: '0x41b3d185',
  depositsPaused: '0x60da3e83',
  lockPeriod: '0x1820cabb',
  feeBps: '0x5b01e374',
  depositsLength: '0xcb85b972',
  depositInfo: '0xb9d774df',
  marketCount: '0xec979082',
  marketSummary: '0xe67298fa',
  myBet: '0xc2aabd3a',
  minBet: '0x9619367d',
};

function decodeMarketSummary(hex) {
  const data = hex && hex.startsWith('0x') ? hex.slice(2) : (hex || '');
  if (data.length < 8 * 64) return null;
  const word = (i) => data.slice(i * 64, i * 64 + 64);
  const offset = Number(hexToBigInt('0x' + word(0)));
  const betDeadline = Number(hexToBigInt('0x' + word(1)));
  const resolveAt = Number(hexToBigInt('0x' + word(2)));
  const totalUp = hexToBigInt('0x' + word(3)).toString();
  const totalDown = hexToBigInt('0x' + word(4)).toString();
  const resolved = hexToBigInt('0x' + word(5)) === 1n;
  const upWon = hexToBigInt('0x' + word(6)) === 1n;
  const potAfterFee = hexToBigInt('0x' + word(7)).toString();
  let label = '';
  try {
    const strStart = offset * 2;
    const strLen = Number(hexToBigInt('0x' + data.slice(strStart, strStart + 64)));
    const strHex = data.slice(strStart + 64, strStart + 64 + strLen * 2);
    const bytes = new Uint8Array(strHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    label = Buffer.from(bytes).toString('utf8');
  } catch (e) { label = ''; }
  return { label, betDeadline, resolveAt, totalUp, totalDown, resolved, upWon, potAfterFee };
}

function decodeDepositInfo(hex) {
  const data = hex && hex.startsWith('0x') ? hex.slice(2) : (hex || '');
  if (data.length < 4 * 64) return null;
  const word = (i) => data.slice(i * 64, i * 64 + 64);
  return {
    principalA: hexToBigInt('0x' + word(0)).toString(),
    liquidity: hexToBigInt('0x' + word(1)).toString(),
    unlockAt: Number(hexToBigInt('0x' + word(2))),
    unlocked: hexToBigInt('0x' + word(3)) === 1n,
  };
}

const MAX_SCAN = 300; // máx. mercados históricos a escanear (cubre meses de largos)
let cache = null; // { ts, base } — caché de datos no-dependientes del usuario

const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  try {
    let address = '';
    try {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
      address = String((body && body.address) || '').toLowerCase();
    } catch (e) { address = ''; }
    const hasAddr = /^0x[a-f0-9]{40}$/.test(address);

    // ---- ronda 1: config de bóvedas + conteo de mercados (con caché 60 s) ----
    let base;
    if (cache && Date.now() - cache.ts < 60000) {
      base = cache.base;
    } else {
      const calls = [];
      const perVault = [];
      for (const v of VAULTS) {
        perVault.push({ min: calls.length, paused: calls.length + 1, lock: calls.length + 2, fee: calls.length + 3 });
        calls.push({ to: v.address, data: SEL.minDeposit });
        calls.push({ to: v.address, data: SEL.depositsPaused });
        calls.push({ to: v.address, data: SEL.lockPeriod });
        calls.push({ to: v.address, data: SEL.feeBps });
      }
      const mcIdx = calls.length;
      calls.push({ to: PREDICT_ADDRESS, data: SEL.marketCount });
      const mbIdx = calls.length;
      calls.push({ to: PREDICT_ADDRESS, data: SEL.minBet });
      const r1 = await rpcBatch(calls);
      const get = (i) => (r1[i] && r1[i].result) || '0x';
      const marketCount = Number(hexToBigInt(get(mcIdx)));
      base = {
        vaultsBase: VAULTS.map((v, i) => ({
          minDeposit: hexToBigInt(get(perVault[i].min)).toString(),
          depositsPaused: hexToBigInt(get(perVault[i].paused)) === 1n,
          lockPeriodDays: Math.round(Number(hexToBigInt(get(perVault[i].lock))) / 86400),
          feeBpsVault: Number(hexToBigInt(get(perVault[i].fee))),
        })),
        marketCount,
        minBet: hexToBigInt(get(mbIdx)).toString(),
      };
      cache = { ts: Date.now(), base };
    }
    const marketCount = base.marketCount;

    // ---- fase cacheable: TODOS los summaries (no depende del usuario) ----
    let summaries;
    if (cache && cache.summaries) {
      summaries = cache.summaries;
    } else {
      const from = Math.max(0, marketCount - MAX_SCAN);
      const sumCalls = [];
      for (let m = from; m < marketCount; m++) sumCalls.push({ to: PREDICT_ADDRESS, data: SEL.marketSummary + padNum(m) });
      const rs = await rpcBatch(sumCalls);
      summaries = { from, list: rs.map((r, k) => ({ id: from + k, ...decodeMarketSummary((r && r.result) || '0x') })) };
      if (cache) cache.summaries = summaries;
      else cache = { ts: Date.now(), base, summaries };
    }
    // IDs a mostrar: todos los NO resueltos (equivalente a status='open', sin
    // límite de edad para que los mercados de 72h/1 semana nunca desaparezcan)
    // + los últimos 15 tal cual (incluye resueltos recientes: el cliente los
    // usa para mostrar el botón de reclamar premio a los ganadores).
    const show = new Set();
    for (const sm of summaries.list) if (sm.label && !sm.resolved) show.add(sm.id);
    for (let m = Math.max(0, marketCount - 15); m < marketCount; m++) show.add(m);
    const ids = Array.from(show).sort((a, b) => a - b);

    // ---- fase por usuario: depósitos + mis apuestas SOLO de los IDs a mostrar ----
    const calls = [];
    const depositIdx = {};
    for (const v of VAULTS) depositIdx[v.id] = [];
    if (hasAddr) {
      const lenCalls = VAULTS.map((v) => ({ to: v.address, data: SEL.depositsLength + padAddr(address) }));
      const lens = await rpcBatch(lenCalls);
      for (let vi = 0; vi < VAULTS.length; vi++) {
        const n = Math.min(Number(hexToBigInt(lens[vi] && lens[vi].result)), 10);
        for (let i = 0; i < n; i++) {
          depositIdx[VAULTS[vi].id].push(calls.length);
          calls.push({ to: VAULTS[vi].address, data: SEL.depositInfo + padAddr(address) + padNum(i) });
        }
      }
    }
    const myBetIdx = {};
    for (const m of ids) {
      if (!hasAddr) break;
      myBetIdx[m] = calls.length;
      calls.push({ to: PREDICT_ADDRESS, data: SEL.myBet + padNum(m) + padAddr(address) });
    }
    const r2 = calls.length > 0 ? await rpcBatch(calls) : [];
    const get2 = (i) => (r2[i] && r2[i].result) || '0x';
    const sumById = new Map(summaries.list.map((sm) => [sm.id, sm]));

    const vaultsOut = VAULTS.map((v, vi) => {
      const deps = (depositIdx[v.id] || []).map((ci, idx) => {
        const d = decodeDepositInfo(get2(ci));
        return d ? { index: idx, principalA: d.principalA, liquidity: d.liquidity, unlockAt: d.unlockAt, unlocked: d.unlocked } : null;
      }).filter(Boolean);
      return {
        id: v.id,
        symA: v.symA,
        address: v.address,
        minDeposit: base.vaultsBase[vi].minDeposit,
        depositsPaused: base.vaultsBase[vi].depositsPaused,
        lockPeriodDays: base.vaultsBase[vi].lockPeriodDays,
        feeBpsVault: base.vaultsBase[vi].feeBpsVault,
        deposits: hasAddr ? deps : [],
      };
    });

    const markets = ids.map((m) => {
      const summary = sumById.get(m);
      if (!summary) return null;
      let myUp = '0';
      let myDown = '0';
      if (hasAddr && myBetIdx[m] !== undefined) {
        const raw = get2(myBetIdx[m]);
        const data = raw.startsWith('0x') ? raw.slice(2) : raw;
        if (data.length >= 128) {
          myUp = hexToBigInt('0x' + data.slice(0, 64)).toString();
          myDown = hexToBigInt('0x' + data.slice(64, 128)).toString();
        }
      }
      return {
        id: m,
        label: summary.label,
        betDeadline: summary.betDeadline,
        resolveAt: summary.resolveAt,
        totalUp: summary.totalUp,
        totalDown: summary.totalDown,
        resolved: summary.resolved,
        upWon: summary.upWon,
        potAfterFee: summary.potAfterFee,
        myUp,
        myDown,
      };
    }).filter(Boolean);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      vaults: vaultsOut,
      predict: { address: PREDICT_ADDRESS, marketCount, minBet: base.minBet, markets },
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Error consultando contratos', detail: String(e) });
  }
});

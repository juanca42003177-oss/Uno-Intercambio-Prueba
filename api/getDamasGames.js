// getDamasGames (Vercel) — lee el lobby de partidas del contrato DamasPot.
// Sin base de datos: escanea gameCount() y games(id) via multicall batch RPC
// (igual patron que getVaultPredictInfo). Cache server-side de 10s.
const { rpcBatch, hexToBigInt, padNum } = require('./_rpc');

const DAMAS_ADDRESS = process.env.DAMAS_ADDRESS || '0x9608221C0f1A3B94657Ef0eE5A792E28191e5004'; // actualizar tras redesplegar
const MAX_SCAN = 200; // ultimas N partidas a escanear (cubre meses de historial)

const SEL = {
  gameCount: '0x4d1975b4',
  games: '0x117a5b90',
}; // igual que antes, el struct Game no cambio de layout en los primeros 5 campos

function decodeGame(hex) {
  // struct Game { address p1; address p2; uint256 stake; uint8 status;
  //               uint256 lastTouch; address p1Vote; address p2Vote; }
  const data = hex && hex.startsWith('0x') ? hex.slice(2) : (hex || '');
  if (data.length < 5 * 64) return null;
  const word = (i) => data.slice(i * 64, i * 64 + 64);
  const p1 = '0x' + word(0).slice(24);
  const p2 = '0x' + word(1).slice(24);
  const stake = hexToBigInt('0x' + word(2)).toString();
  const status = Number(hexToBigInt('0x' + word(3)));
  const lastTouch = Number(hexToBigInt('0x' + word(4)));
  return { p1, p2, stake, status, lastTouch };
}

let cache = null; // { ts, games }

const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  try {
    if (cache && Date.now() - cache.ts < 10000) {
      return res.json({ ok: true, games: cache.games });
    }
    const cnt = await rpcBatch([{ to: DAMAS_ADDRESS, data: SEL.gameCount }]);
    const total = cnt[0] && cnt[0].result ? Number(hexToBigInt(cnt[0].result)) : 0;
    const from = Math.max(1, total - MAX_SCAN + 1);
    const ids = [];
    for (let id = total; id >= from; id--) ids.push(id);
    if (ids.length === 0) {
      cache = { ts: Date.now(), games: [] };
      return res.json({ ok: true, games: [] });
    }
    const calls = ids.map((id) => ({ to: DAMAS_ADDRESS, data: SEL.games + padNum(id) }));
    const results = await rpcBatch(calls);
    const games = [];
    for (let i = 0; i < ids.length; i++) {
      const r = results[i];
      if (!r || !r.result || r.result === '0x') continue;
      const g = decodeGame(r.result);
      if (!g) continue;
      games.push({ id: ids[i], ...g });
    }
    cache = { ts: Date.now(), games };
    return res.json({ ok: true, games });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// damas.js — Juego de Damas P2P con apuesta en WLD, Dragon Trade.
// Mismo estilo que el resto de la app: SIN ethers.js, codificacion manual +
// MiniKit.sendTransaction (compatible con la smart wallet de World App).
// Motor de reglas (damas americanas: captura obligatoria, reyes 1 casilla) +
// lobby/tablero + relay de jugadas via /api/damasMoves + liquidacion on-chain
// via el contrato DamasPot (cada jugador vota el resultado con su propia tx).

const DAMAS_ADDRESS = '0x9608221C0f1A3B94657Ef0eE5A792E28191e5004'; // actualizar tras redesplegar
const DAMAS_WLD = '0x2cFc85d8E48F8EAB294be644d9E25C3030863003';
const DAMAS_MOVES_URL = 'https://intercambiox.vercel.app/api/damasMoves'; // relay central (CORS abierto)

// ---- codificacion de las llamadas del contrato (mismo estilo que el resto de index.html) ----
function encodeDamasUint(n) { return BigInt(n).toString(16).padStart(64, '0'); }
function encodeDamasAddr(a) { return a.slice(2).toLowerCase().padStart(64, '0'); }
function encCreateGame(stakeWei)      { return '0x48e837b9' + encodeDamasUint(stakeWei); }
function encJoinGame(id)              { return '0xefaa55a0' + encodeDamasUint(id); }
function encCancelGame(id)            { return '0x69958ab9' + encodeDamasUint(id); }
function encTouch(id)                 { return '0xedaa0c1d' + encodeDamasUint(id); }
function encConfirmResult(id, winner) { return '0x9c338d6b' + encodeDamasUint(id) + encodeDamasAddr(winner); }
function encResign(id)                { return '0x08d9801c' + encodeDamasUint(id); }
function encClaimTimeout(id)          { return '0x86e773f1' + encodeDamasUint(id); }

let damasPollTimer = null;
let damasCurrentGame = null; // { id, me: 'p1'|'p2', p1, p2, stake, board, turn, log, selected, settling }

// ---------------- tablero ----------------
// 8x8, casillas jugables (oscuras) indexadas 0-31 (notacion estandar de damas).
// board[sq] = 0 vacio, 1=hombre p1, 2=hombre p2, 3=rey p1, 4=rey p2.
function damasInitialBoard() {
  const b = new Array(32).fill(0);
  for (let i = 0; i < 12; i++) b[i] = 2;      // p2 arriba
  for (let i = 20; i < 32; i++) b[i] = 1;     // p1 abajo
  return b;
}
function sqToRC(sq) {
  const row = Math.floor(sq / 4);
  const col = (sq % 4) * 2 + ((row % 2 === 0) ? 1 : 0);
  return [row, col];
}
function rcToSq(row, col) {
  if (row < 0 || row > 7 || col < 0 || col > 7) return -1;
  if ((row + col) % 2 === 0) return -1; // casilla clara, no jugable
  return row * 4 + Math.floor(col / 2);
}
function isP1(p) { return p === 1 || p === 3; }
function isP2(p) { return p === 2 || p === 4; }
function isKing(p) { return p === 3 || p === 4; }
function mine(p, side) { return side === 'p1' ? isP1(p) : isP2(p); }
function theirs(p, side) { return side === 'p1' ? isP2(p) : isP1(p); }

function damasSimpleMoves(board, sq, side) {
  const [r, c] = sqToRC(sq);
  const p = board[sq];
  const dirs = isKing(p) ? [-1, 1] : (side === 'p1' ? [-1] : [1]);
  const out = [];
  for (const dr of dirs) {
    for (const dc of [-1, 1]) {
      const t = rcToSq(r + dr, c + dc);
      if (t >= 0 && board[t] === 0) out.push({ from: sq, to: t, captures: [] });
    }
  }
  return out;
}
function damasCaptureMoves(board, sq, side, visited) {
  const [r, c] = sqToRC(sq);
  const p = board[sq];
  const dirs = [-1, 1]; // al capturar, hasta los hombres pueden saltar hacia atras
  const results = [];
  for (const dr of dirs) {
    for (const dc of [-1, 1]) {
      const midSq = rcToSq(r + dr, c + dc);
      const landSq = rcToSq(r + 2 * dr, c + 2 * dc);
      if (midSq < 0 || landSq < 0) continue;
      if (!theirs(board[midSq], side)) continue;
      if (board[landSq] !== 0) continue;
      if (visited && visited.has(midSq)) continue;
      const b2 = board.slice();
      b2[landSq] = b2[sq]; b2[sq] = 0; b2[midSq] = 0;
      const v2 = new Set(visited); v2.add(midSq);
      const further = damasCaptureMoves(b2, landSq, side, v2);
      if (further.length === 0) {
        results.push({ from: sq, to: landSq, captures: [midSq] });
      } else {
        for (const f of further) results.push({ from: sq, to: f.to, captures: [midSq, ...f.captures] });
      }
    }
  }
  return results;
}
function damasLegalMoves(board, side) {
  let caps = [];
  for (let sq = 0; sq < 32; sq++) {
    if (!mine(board[sq], side)) continue;
    caps = caps.concat(damasCaptureMoves(board, sq, side, new Set()));
  }
  if (caps.length > 0) return caps;
  let simples = [];
  for (let sq = 0; sq < 32; sq++) {
    if (!mine(board[sq], side)) continue;
    simples = simples.concat(damasSimpleMoves(board, sq, side));
  }
  return simples;
}
function damasApplyMove(board, move, side) {
  const b = board.slice();
  const piece = b[move.from];
  b[move.from] = 0;
  for (const mid of (move.captures || [])) b[mid] = 0;
  b[move.to] = piece;
  const [rowTo] = sqToRC(move.to);
  if (!isKing(piece)) {
    if (side === 'p1' && rowTo === 0) b[move.to] = 3;
    if (side === 'p2' && rowTo === 7) b[move.to] = 4;
  }
  return b;
}
function damasCountSide(board, side) {
  let n = 0;
  for (const p of board) if (mine(p, side)) n++;
  return n;
}
function damasRebuild(log) {
  let board = damasInitialBoard();
  let turn = 'p1';
  for (const entry of log) {
    if (entry.type === 'move') { board = damasApplyMove(board, entry.move, entry.by); turn = entry.by === 'p1' ? 'p2' : 'p1'; }
  }
  return { board, turn };
}

// ---------------- transacciones (MiniKit, igual que el resto de la app) ----------------
async function damasSendTx(txs, waitMsg) {
  showOk(waitMsg || 'Confirma en World App...', '⏳');
  const result = await MiniKit.sendTransaction({ chainId: 480, transactions: txs });
  if (!(result && result.data && result.data.userOpHash)) throw new Error('Transacción cancelada');
  return result;
}

// ---------------- lobby ----------------
async function damasRefreshLobby() {
  const el = document.getElementById('damasLobby');
  if (!el) return;
  el.innerHTML = '<div class="damas-muted">Cargando retos abiertos...</div>';
  try {
    const url = await apiEndpoint('getDamasGames');
    const r = await fetch(url);
    const j = await r.json();
    const games = (j && j.games) || [];
    const myAddr = currentAccount ? currentAccount.toLowerCase() : '';
    const open = games.filter((g) => g.status === 1);
    const mineActive = games.filter((g) => (g.status === 2 || g.status === 4) && myAddr && (g.p1.toLowerCase() === myAddr || g.p2.toLowerCase() === myAddr));
    let html = '';
    if (mineActive.length > 0) {
      html += '<div class="damas-section">Tus partidas activas</div>';
      for (const g of mineActive) {
        const wldAmt = damasFmtWld(g.stake);
        const disp = g.status === 4 ? ' <span class="pillRed" style="margin-left:6px">⚠️ en disputa</span>' : '';
        html += `<div class="damas-card"><b>Partida #${g.id}</b>${disp}<br>Apuesta: ${wldAmt} WLD cada uno<br>
          <button class="btnY" onclick="damasOpenActiveGame(${g.id})">▶️ Continuar partida</button></div>`;
      }
    }
    html += '<div class="damas-section">Retos abiertos</div>';
    if (open.length === 0) html += '<div class="damas-muted">No hay retos abiertos. ¡Crea el primero!</div>';
    for (const g of open) {
      const wldAmt = damasFmtWld(g.stake);
      const isMine = myAddr && g.p1.toLowerCase() === myAddr;
      html += `<div class="damas-card"><b>Reto #${g.id}</b><br>Apuesta: ${wldAmt} WLD<br>Creado por: ${g.p1.slice(0, 6)}...${g.p1.slice(-4)}<br>
        ${isMine
          ? `<button class="btnY" style="background:var(--card2);color:#eaecef" onclick="damasCancelGame(${g.id})">❌ Cancelar mi reto</button>`
          : `<button class="btnY" onclick="damasJoinGame(${g.id}, '${g.stake}')">⚔️ Aceptar reto (${wldAmt} WLD)</button>`}
      </div>`;
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="damas-muted err">Error cargando el lobby: ' + e.message + '</div>';
  }
}
function damasFmtWld(weiStr) {
  const n = Number(BigInt(weiStr)) / 1e18;
  return n.toFixed(n < 10 ? 2 : 0);
}

async function damasCreateGame(stakeWldStr) {
  if (!currentAccount) return showOk('Conecta tu wallet', '⚠️');
  const amountWei = toRawAmount(parseFloat(stakeWldStr), 18);
  try {
    await damasSendTx([
      { to: DAMAS_WLD, data: encodeApprove(DAMAS_ADDRESS, 0n), value: '0x0' },
      { to: DAMAS_WLD, data: encodeApprove(DAMAS_ADDRESS, amountWei), value: '0x0' },
      { to: DAMAS_ADDRESS, data: encCreateGame(amountWei), value: '0x0' },
    ], 'Creando reto en World App...');
    showOk('✅ Reto creado. Esperá a que alguien lo acepte.', '✅');
    setTimeout(damasRefreshLobby, 2500);
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

async function damasJoinGame(id, stakeWeiStr) {
  if (!currentAccount) return showOk('Conecta tu wallet', '⚠️');
  try {
    await damasSendTx([
      { to: DAMAS_WLD, data: encodeApprove(DAMAS_ADDRESS, 0n), value: '0x0' },
      { to: DAMAS_WLD, data: encodeApprove(DAMAS_ADDRESS, BigInt(stakeWeiStr)), value: '0x0' },
      { to: DAMAS_ADDRESS, data: encJoinGame(id), value: '0x0' },
    ], 'Uniéndote al reto en World App...');
    showOk('✅ ¡Partida empezada!', '✅');
    setTimeout(() => damasOpenActiveGame(id), 2000);
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

async function damasCancelGame(id) {
  try {
    await damasSendTx([{ to: DAMAS_ADDRESS, data: encCancelGame(id), value: '0x0' }], 'Cancelando reto...');
    showOk('✅ Reto cancelado, WLD devuelto.', '✅');
    setTimeout(damasRefreshLobby, 2500);
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

// ---------------- partida activa ----------------
async function damasOpenActiveGame(id) {
  if (!currentAccount) return showOk('Conecta tu wallet', '⚠️');
  try {
    const url = await apiEndpoint('getDamasGames');
    const r = await fetch(url);
    const j = await r.json();
    const g0 = (j.games || []).find((x) => x.id === id);
    if (!g0) { showOk('Partida no encontrada', '❌'); return; }
    const myAddr = currentAccount.toLowerCase();
    const side = g0.p1.toLowerCase() === myAddr ? 'p1' : 'p2';
    const stateUrl = DAMAS_MOVES_URL;
    const sr = await fetch(stateUrl + '?action=state&gameId=' + id);
    const sj = await sr.json();
    const log = (sj && sj.log) || [];
    const { board, turn } = damasRebuild(log);
    damasCurrentGame = { id, me: side, p1: g0.p1, p2: g0.p2, stake: g0.stake, status: g0.status, board, turn, log, selected: null, settling: false };
    document.getElementById('damasLobbyView').style.display = 'none';
    document.getElementById('damasBoardView').style.display = 'block';
    damasRenderBoard();
    if (damasPollTimer) clearInterval(damasPollTimer);
    damasPollTimer = setInterval(damasPollMoves, 4000);
    if (g0.status === 2) {
      try { await MiniKit.sendTransaction({ chainId: 480, transactions: [{ to: DAMAS_ADDRESS, data: encTouch(id), value: '0x0' }] }); } catch (e) { /* no critico */ }
    }
    if (g0.status === 4) damasShowDispute();
  } catch (e) { showOk('Error abriendo la partida: ' + (e.message || e), '❌'); }
}

function damasExitGame() {
  if (damasPollTimer) { clearInterval(damasPollTimer); damasPollTimer = null; }
  damasCurrentGame = null;
  document.getElementById('damasBoardView').style.display = 'none';
  document.getElementById('damasLobbyView').style.display = 'block';
  damasRefreshLobby();
}

async function damasPollMoves() {
  const g = damasCurrentGame;
  if (!g || g.settling) return;
  try {
    const stateUrl = DAMAS_MOVES_URL;
    const r = await fetch(stateUrl + '?action=state&gameId=' + g.id);
    const j = await r.json();
    const log = (j && j.log) || [];
    if (log.length !== g.log.length) {
      const rb = damasRebuild(log);
      g.log = log; g.board = rb.board; g.turn = rb.turn; g.selected = null;
      damasRenderBoard();
    }
    damasCheckGameOver();
  } catch (e) { /* reintenta en el proximo poll */ }
}

function damasRenderBoard() {
  const g = damasCurrentGame;
  const el = document.getElementById('damasBoard');
  if (!g || !el) return;
  const flip = g.me === 'p2'; // cada jugador ve sus piezas abajo
  let html = '<div class="damas-grid">';
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const row = flip ? 7 - rr : rr;
      const col = flip ? 7 - cc : cc;
      const dark = (row + col) % 2 === 1;
      const sq = dark ? rcToSq(row, col) : -1;
      const piece = sq >= 0 ? g.board[sq] : 0;
      const sel = g.selected === sq;
      let inner = '';
      if (piece) {
        const cls = isP1(piece) ? 'damas-p1' : 'damas-p2';
        inner = `<div class="damas-piece ${cls}${isKing(piece) ? ' damas-king' : ''}"></div>`;
      }
      html += `<div class="damas-sq ${dark ? 'dark' : 'light'}${sel ? ' sel' : ''}" ${sq >= 0 ? `onclick="damasClickSquare(${sq})"` : ''}>${inner}</div>`;
    }
  }
  html += '</div>';
  const turnTxt = g.turn === g.me ? '🟢 Tu turno' : '⏳ Turno del rival';
  const tEl = document.getElementById('damasTurnInfo');
  if (tEl) tEl.textContent = turnTxt;
  el.innerHTML = html;
}

function damasClickSquare(sq) {
  const g = damasCurrentGame;
  if (!g || g.settling || g.turn !== g.me) return;
  const legal = damasLegalMoves(g.board, g.me);
  if (g.selected === null) {
    if (mine(g.board[sq], g.me) && legal.some((m) => m.from === sq)) { g.selected = sq; damasRenderBoard(); }
    return;
  }
  const move = legal.find((m) => m.from === g.selected && m.to === sq);
  if (move) {
    damasSendMove(move);
    return;
  } else if (mine(g.board[sq], g.me) && legal.some((m) => m.from === sq)) {
    g.selected = sq;
  } else {
    g.selected = null;
  }
  damasRenderBoard();
}

async function damasSendMove(move) {
  const g = damasCurrentGame;
  const idx = g.log.length;
  const entry = { type: 'move', move, by: g.me };
  try {
    const url = DAMAS_MOVES_URL;
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move', gameId: g.id, idx, entry }),
    });
    const j = await r.json();
    if (!j.ok) { showOk('Error enviando jugada', '❌'); return; }
    const rb = damasRebuild(j.log);
    g.log = j.log; g.board = rb.board; g.turn = rb.turn; g.selected = null;
    damasRenderBoard();
    damasCheckGameOver();
  } catch (e) { showOk('Error de red enviando jugada', '❌'); }
}

function damasCheckGameOver() {
  const g = damasCurrentGame;
  if (!g || g.settling) return;
  const p1Count = damasCountSide(g.board, 'p1');
  const p2Count = damasCountSide(g.board, 'p2');
  const p1Moves = damasLegalMoves(g.board, 'p1').length;
  const p2Moves = damasLegalMoves(g.board, 'p2').length;
  let winnerSide = null;
  if (p2Count === 0 || p2Moves === 0) winnerSide = 'p1';
  else if (p1Count === 0 || p1Moves === 0) winnerSide = 'p2';
  if (!winnerSide) return;
  g.settling = true;
  const winnerAddr = winnerSide === 'p1' ? g.p1 : g.p2;
  const tEl = document.getElementById('damasTurnInfo');
  if (tEl) tEl.textContent = (winnerSide === g.me ? '🏆 ¡Ganaste!' : '😔 Perdiste') + ' — confirmá el resultado para liquidar el pozo.';
  damasShowConfirmBtn(winnerAddr);
}

function damasShowConfirmBtn(winnerAddr) {
  const box = document.getElementById('damasActionsBox');
  if (!box) return;
  box.innerHTML = `<button class="btnY" onclick="damasConfirmResult('${winnerAddr}')">✅ Confirmar resultado y cobrar</button>`;
}

async function damasConfirmResult(winnerAddr) {
  const g = damasCurrentGame;
  try {
    await damasSendTx([{ to: DAMAS_ADDRESS, data: encConfirmResult(g.id, winnerAddr), value: '0x0' }], 'Confirmando resultado en World App...');
    showOk('Resultado confirmado. Si el rival confirma lo mismo, el pozo se paga solo.', '⏳');
    damasPollSettleStatus();
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

async function damasPollSettleStatus() {
  const g = damasCurrentGame;
  if (!g) return;
  try {
    const url = await apiEndpoint('getDamasGames');
    const r = await fetch(url);
    const j = await r.json();
    const g0 = (j.games || []).find((x) => x.id === g.id);
    if (!g0) return;
    if (g0.status === 3) {
      const box = document.getElementById('damasActionsBox');
      if (box) box.innerHTML = '<div class="damas-muted" style="color:var(--green);font-weight:800">✅ Pozo pagado. Partida terminada.</div>';
      return;
    }
    if (g0.status === 4) { damasShowDispute(); return; }
    setTimeout(damasPollSettleStatus, 5000);
  } catch (e) { setTimeout(damasPollSettleStatus, 7000); }
}

function damasShowDispute() {
  const box = document.getElementById('damasActionsBox');
  if (box) box.innerHTML = '<div class="damas-muted err">⚠️ Los dos jugadores confirmaron resultados distintos. Dragon Trade revisará y arbitrará el pozo.</div>';
}

async function damasResign() {
  const g = damasCurrentGame;
  if (!g || !confirm('¿Seguro que te rendís? El rival se queda con todo el pozo.')) return;
  try {
    await damasSendTx([{ to: DAMAS_ADDRESS, data: encResign(g.id), value: '0x0' }], 'Confirmando en World App...');
    showOk('Te rendiste. El pozo fue pagado al rival.', '✅');
    damasExitGame();
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

async function damasClaimTimeout() {
  const g = damasCurrentGame;
  if (!g) return;
  try {
    await damasSendTx([{ to: DAMAS_ADDRESS, data: encClaimTimeout(g.id), value: '0x0' }], 'Cobrando por abandono...');
    showOk('✅ Pozo cobrado por abandono del rival.', '✅');
    damasExitGame();
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

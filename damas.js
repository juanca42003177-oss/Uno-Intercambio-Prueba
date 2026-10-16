// damas.js — Juego de Damas P2P con apuesta en WLD, Dragon Trade.
// Mismo estilo que el resto de la app: SIN ethers.js, codificacion manual +
// MiniKit.sendTransaction (compatible con la smart wallet de World App).
// Motor de reglas (damas americanas: captura obligatoria, reyes 1 casilla) +
// lobby/tablero + relay de jugadas via /api/damasMoves + liquidacion on-chain
// via el contrato DamasPot (cada jugador vota el resultado con su propia tx).

const DAMAS_ADDRESS = '0x9E8D281d80441763dbC1AF701FCc510B8A36D155'; // DamasPot v4 (claimTimeout fix + comision 1% tambien en tablas), desplegado 2026-10-12
const DAMAS_WLD = '0x2cFc85d8E48F8EAB294be644d9E25C3030863003';
const DAMAS_MOVES_URL = 'https://dragontrade.vercel.app/api/damasMoves'; // relay central (CORS abierto)

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

// ---------------- modo practica (gratis, contra la IA del dragon) ----------------
// Sin apuesta, sin gas, sin contrato: 100% en el navegador.
let damasPractice = null; // { board, turn, selected, depth, over }

function damasStartPractice(depth) {
  damasPractice = { board: damasInitialBoard(), turn: 'p1', selected: null, depth: Number(depth) || 3, over: false };
  document.getElementById('damasLobbyView').style.display = 'none';
  document.getElementById('damasBoardView').style.display = 'block'; (function(){var x=document.getElementById('damasHead'); if(x) x.style.display='none';})();
  document.getElementById('damasEmoteBar').style.display = 'none';       // emojis solo en P2P
  document.getElementById('damasPvpButtons').style.display = 'none';      // sin rendirse/cobrar
  document.getElementById('damasExitBtn').textContent = '← Terminar práctica';
  document.getElementById('damasActionsBox').innerHTML = '';
  if (damasPollTimer) { clearInterval(damasPollTimer); damasPollTimer = null; }
  damasRenderPractice();
}

function damasExitPractice() {
  damasPractice = null;
  document.getElementById('damasEmoteBar').style.display = 'flex';
  document.getElementById('damasPvpButtons').style.display = 'grid';
  document.getElementById('damasExitBtn').textContent = '← Volver al lobby';
  document.getElementById('damasLobbyView').style.display = 'block';
  document.getElementById('damasBoardView').style.display = 'none'; (function(){var x=document.getElementById('damasHead'); if(x) x.style.display='';})();
}

// ---- modal de confirmacion propio (confirm() nativo no muestra botones en World App) ----
function damasAsk(message, okText, cancelText) {
  return new Promise(function (resolve) {
    var old = document.getElementById('damasAskOverlay'); if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'damasAskOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:99999;display:flex;align-items:center;justify-content:center;padding:22px';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1e2329;border:1px solid #f0b90b;border-radius:14px;padding:22px 18px;max-width:340px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.6)';
    var p = document.createElement('div');
    p.style.cssText = 'color:#eaecef;font-size:14.5px;line-height:1.55;text-align:center;white-space:pre-line;margin-bottom:18px';
    p.textContent = message;
    var keep = document.createElement('button');
    keep.textContent = cancelText || 'Continuar jugando';
    keep.style.cssText = 'width:100%;padding:14px;border:0;border-radius:10px;background:#f0b90b;color:#1e2329;font-weight:800;font-size:15px;margin-bottom:10px;cursor:pointer';
    var leave = document.createElement('button');
    leave.textContent = okText || 'Salir';
    leave.style.cssText = 'width:100%;padding:12px;border:1px solid #474d57;border-radius:10px;background:transparent;color:#848e9c;font-weight:700;font-size:13px;cursor:pointer';
    function done(v) { ov.remove(); resolve(v); }
    keep.onclick = function () { done(false); };
    leave.onclick = function () { done(true); };
    box.appendChild(p); box.appendChild(keep); box.appendChild(leave); ov.appendChild(box);
    document.body.appendChild(ov);
  });
}

// ¿hay una partida en curso en pantalla? (practica sin terminar o partida real activa)
function damasInMatch() {
  var bv = document.getElementById('damasBoardView');
  if (!bv || bv.style.display === 'none') return false;
  if (damasPractice) return !damasPractice.over;
  return !!(damasCurrentGame && (damasCurrentGame.status === 2 || damasCurrentGame.status === 4));
}
function damasLeaveWarning() {
  return damasPractice
    ? '⚠️ Tienes una práctica en curso.\n¿Seguro que quieres salir? Perderás esta partida.'
    : '⚠️ Tienes una partida con apuesta en curso.\nSi sales, tu rival sigue esperando y el tiempo corre.\n¿Seguro que quieres salir?';
}
async function damasLeaveBoard() {
  if (damasInMatch() && !(await damasAsk(damasLeaveWarning(), 'Sí, salir', 'Continuar jugando'))) return;
  if (damasPractice) damasExitPractice();
  else damasExitGame();
}

// ---- IA: minimax con poda alfa-beta sobre el mismo motor de reglas ----
function practiceEval(b) { // >0 favorece al dragon (p2)
  let s = 0;
  for (const p of b) {
    if (p === 2) s += 1; else if (p === 4) s += 1.6;
    else if (p === 1) s -= 1; else if (p === 3) s -= 1.6;
  }
  return s;
}
function practiceSearch(board, side, depth, alpha, beta) {
  const moves = damasLegalMoves(board, side);
  if (moves.length === 0) return side === 'p2' ? -99 : 99; // sin jugadas = pierde
  if (depth <= 0) return practiceEval(board);
  if (side === 'p2') {
    let best = -Infinity;
    for (const m of moves) {
      const v = practiceSearch(damasApplyMove(board, m, side), 'p1', depth - 1, alpha, beta);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    const v = practiceSearch(damasApplyMove(board, m, side), 'p2', depth - 1, alpha, beta);
    if (v < best) best = v;
    if (best < beta) beta = best;
    if (beta <= alpha) break;
  }
  return best;
}
function practiceBestMove(g) {
  const moves = damasLegalMoves(g.board, 'p2');
  if (!moves.length) return null;
  if (g.depth === 1) { // facil: jugada al azar
    return moves[Math.floor(Math.random() * moves.length)];
  }
  let best = null, bv = -Infinity;
  for (const m of moves) {
    const v = practiceSearch(damasApplyMove(g.board, m, 'p2'), 'p1', g.depth - 1, -Infinity, Infinity) + Math.random() * 0.01;
    if (v > bv) { bv = v; best = m; }
  }
  return best;
}

function damasRenderPractice() {
  const g = damasPractice;
  const el = document.getElementById('damasBoard');
  if (!g || !el) return;
  const legal = g.over ? [] : damasLegalMoves(g.board, 'p1');
  const targets = new Map();
  for (const m of legal) if (g.selected === m.from) targets.set(m.to, m.captures.length);
  let html = '<div class="damas-grid">';
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const row = 7 - rr; // el jugador siempre abajo (p1)
      const col = cc;
      const dark = (row + col) % 2 === 1;
      const sq = dark ? rcToSq(row, col) : -1;
      const piece = sq >= 0 ? g.board[sq] : 0;
      const sel = g.selected === sq;
      const hint = sq >= 0 && targets.has(sq);
      let inner = '';
      if (piece) {
        const cls = isP1(piece) ? 'damas-p1' : 'damas-p2';
        inner = `<div class="damas-piece ${cls}${isKing(piece) ? ' damas-king' : ''}">${isKing(piece) ? '<div class="damas-crown">👑</div>' : ''}</div>`;
      }
      if (hint) inner += '<div class="damas-hint"></div>';
      html += `<div class="damas-sq ${dark ? 'dark' : 'light'}${sel ? ' sel' : ''}" ${sq >= 0 && !g.over ? `onclick="damasPracticeClick(${sq})"` : ''}>${inner}</div>`;
    }
  }
  html += '</div>';
  el.innerHTML = html;
  // encabezado de practica
  const t = document.getElementById('damasTurnInfo');
  if (t) t.textContent = g.over ? '🏆 Práctica terminada' : (g.turn === 'p1' ? '🟢 Tu turno' : '🐉 Pensando el dragón…');
  const a1 = document.getElementById('damasP1Avatar'); if (a1) { a1.textContent = 'TÚ'; a1.classList.remove('rival'); }
  const a2 = document.getElementById('damasP2Avatar'); if (a2) { a2.textContent = '🐉'; a2.classList.add('rival'); }
  const n1 = document.getElementById('damasP1Name'); if (n1) n1.textContent = 'Tú';
  const n2 = document.getElementById('damasP2Name'); if (n2) n2.textContent = 'Dragón IA';
  const capMe = 12 - damasCountSide(g.board, 'p2');
  const capAi = 12 - damasCountSide(g.board, 'p1');
  const m1 = document.getElementById('damasP1Meta'); if (m1) m1.innerHTML = '<span class="damas-chip">GRATIS</span>Capturadas: ' + capMe;
  const m2 = document.getElementById('damasP2Meta'); if (m2) m2.innerHTML = '<span class="damas-chip">GRATIS</span>Capturadas: ' + capAi;
  const pot = document.getElementById('damasPotAmt'); if (pot) pot.textContent = 'Práctica';
  const c1 = document.getElementById('damasP1Card'); if (c1) c1.classList.toggle('turn', !g.over && g.turn === 'p1');
  const c2 = document.getElementById('damasP2Card'); if (c2) c2.classList.toggle('turn', !g.over && g.turn === 'p2');
}

function damasPracticeClick(sq) {
  const g = damasPractice;
  if (!g || g.over || g.turn !== 'p1') return;
  const legal = damasLegalMoves(g.board, 'p1');
  if (g.selected === null) {
    if (mine(g.board[sq], 'p1') && legal.some((m) => m.from === sq)) { g.selected = sq; damasRenderPractice(); }
    return;
  }
  const move = legal.find((m) => m.from === g.selected && m.to === sq);
  if (move) {
    g.board = damasApplyMove(g.board, move, 'p1');
    g.selected = null;
    g.turn = 'p2';
    damasRenderPractice();
    practiceCheckEnd() || setTimeout(practiceAITurn, 420); // pequeño instante "pensando"
  } else if (mine(g.board[sq], 'p1') && legal.some((m) => m.from === sq)) {
    g.selected = sq; damasRenderPractice();
  } else {
    g.selected = null; damasRenderPractice();
  }
}

function practiceAITurn() {
  const g = damasPractice;
  if (!g || g.over || g.turn !== 'p2') return;
  const m = practiceBestMove(g);
  if (m) g.board = damasApplyMove(g.board, m, 'p2');
  g.turn = 'p1';
  damasRenderPractice();
  practiceCheckEnd();
}

function practiceCheckEnd() {
  const g = damasPractice;
  if (!g || g.over) return false;
  const myCount = damasCountSide(g.board, 'p1');
  const aiCount = damasCountSide(g.board, 'p2');
  const myMoves = damasLegalMoves(g.board, 'p1').length;
  const aiMoves = damasLegalMoves(g.board, 'p2').length;
  let msg = null;
  if (aiCount === 0 || aiMoves === 0) msg = '🏆 ¡Le ganaste al dragón! ¿Listo para apostar de verdad?';
  else if (myCount === 0 || myMoves === 0) msg = '🐉 El dragón te venció. ¡Otra vez y le vas a ganar!';
  if (!msg) return false;
  g.over = true;
  const t = document.getElementById('damasTurnInfo');
  if (t) t.textContent = msg;
  const box = document.getElementById('damasActionsBox');
  if (box) box.innerHTML = '<button class="btnY" style="width:100%;margin-top:10px" onclick="damasRestartPractice()">🎯 Jugar otra vez</button>';
  damasRenderPractice();
  return true;
}

function damasRestartPractice() {
  const g = damasPractice;
  if (!g) return;
  damasStartPractice(g.depth);
}

// ---------------- lobby ----------------
var damasLobbyTimer = null;
var damasLastLobbyHtml = null;

function damasLobbyVisible() {
  try {
    const lv = document.getElementById('damasLobbyView');
    const dv = document.getElementById('damasBoardView');
    return !!(lv && dv && lv.style.display !== 'none' && dv.style.display === 'none');
  } catch (e) { return false; }
}

// refresco automatico del lobby cada 15 s mientras se ve (y al volver de segundo plano)
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && damasLobbyVisible()) damasRefreshLobby();
});
if (damasLobbyTimer === null) damasLobbyTimer = setInterval(function () {
  if (damasLobbyVisible()) damasRefreshLobby();
}, 15000);

// esperar a que el cambio se refleje en la lista, reintentando cada 2.5 s
async function damasWaitLobby(check, attempts) {
  for (let i = 0; i < (attempts || 4); i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try { const open = await damasRefreshLobby(); if (check(open)) return true; } catch (e) {}
  }
  return false;
}

async function damasRefreshLobby() {
  try { damasUpdateLimitsLabel(); } catch (e) {}
  const el = document.getElementById('damasLobby');
  if (!el) return;
  el.innerHTML = '<div class="damas-muted">Cargando retos abiertos...</div>';
  try {
    const url = await apiEndpoint('getDamasGames');
    let j = null, lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(function () { ctrl.abort(); }, 12000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        j = await r.json();
        break;
      } catch (e2) { lastErr = e2; await new Promise((r2) => setTimeout(r2, 1500)); }
    }
    if (!j) throw (lastErr || new Error('sin respuesta'));
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
    if (html !== damasLastLobbyHtml) { el.innerHTML = html; damasLastLobbyHtml = html; }
    return open;
  } catch (e) {
    if (!damasLastLobbyHtml) el.innerHTML = '<div class="damas-muted err">No se pudo cargar el lobby.<br><button class="btnY" style="margin-top:8px" onclick="damasRefreshLobby()">🔄 Reintentar</button></div>';
    return [];
  }
}
function damasFmtWld(weiStr) {
  const n = Number(BigInt(weiStr)) / 1e18;
  return n.toFixed(n < 10 ? 2 : 0);
}

// ---------------- emojis estilo Clash ----------------
let damasLastEmoteTs = 0;
function damasSendEmote(e) {
  const g = damasCurrentGame;
  if (!g) return;
  if (Date.now() - damasLastEmoteTs < 2000) return; // no spamear
  damasLastEmoteTs = Date.now();
  fetch(DAMAS_MOVES_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'emote', gameId: g.id, by: currentAccount, emote: e }),
  }).catch(() => {});
  damasShowEmote(e, g.me); // mostrar el propio al instante
}
function damasShowEmote(e, side) {
  const layer = document.getElementById('damasEmoteLayer');
  if (!layer) return;
  const d = document.createElement('div');
  d.className = 'damas-float';
  d.textContent = e;
  d.style.left = side === 'p1' ? '10%' : '74%';
  layer.appendChild(d);
  setTimeout(() => d.remove(), 2500);
}
function damasHandleEmotes(emotes) {
  const g = damasCurrentGame;
  if (!g || !Array.isArray(emotes)) return;
  for (const em of emotes) {
    if (!em || typeof em.ts !== 'number' || em.ts <= g.emotesSeen) continue;
    g.emotesSeen = em.ts;
    const by = String(em.by || '').toLowerCase();
    if (by === (currentAccount || '').toLowerCase()) continue; // el propio ya se mostro
    damasShowEmote(em.emote, by === g.p1.toLowerCase() ? 'p1' : 'p2');
  }
}

// Limites de apuesta: minimo 1 WLD, maximo el equivalente a $10 al precio vivo del WLD.
const DAMAS_MAX_USD = 10;
function damasStakeLimits() {
  const px = (typeof prices !== 'undefined' && prices && prices.WLD) ? Number(prices.WLD) : 0;
  const max = px > 0 ? Math.floor((DAMAS_MAX_USD / px) * 10) / 10 : 20; // sin precio: 20 WLD por defecto
  return { min: 1, max: Math.max(1, max), px };
}
function damasUpdateLimitsLabel() {
  const l = damasStakeLimits();
  const el = document.getElementById('damasMinMax');
  if (el) el.textContent = 'mín ' + l.min + ' WLD — máx ' + l.max + ' WLD (≈ $' + DAMAS_MAX_USD + ')';
  const inp = document.getElementById('damasStakeInput');
  if (inp) { inp.min = String(l.min); inp.max = String(l.max); }
}

async function damasCreateGame(stakeWldStr) {
  if (!currentAccount) return showOk('Conecta tu wallet', '⚠️');
  const lim = damasStakeLimits();
  const val = parseFloat(stakeWldStr);
  if (!isFinite(val) || val < lim.min) return showOk('La apuesta mínima es ' + lim.min + ' WLD', '⚠️');
  if (val > lim.max) return showOk('La apuesta máxima es ' + lim.max + ' WLD (≈ $' + DAMAS_MAX_USD + ')', '⚠️');
  const amountWei = toRawAmount(val, 18);
  try {
    await damasSendTx([
      { to: DAMAS_WLD, data: encodeApprove(DAMAS_ADDRESS, 0n), value: '0x0' },
      { to: DAMAS_WLD, data: encodeApprove(DAMAS_ADDRESS, amountWei), value: '0x0' },
      { to: DAMAS_ADDRESS, data: encCreateGame(amountWei), value: '0x0' },
    ], 'Creando reto en World App...');
    showOk('✅ Reto creado. Esperá a que alguien lo acepte.', '✅');
    damasWaitLobby(function (open) {
      return (open || []).some(function (g) { return currentAccount && g.p1 && g.p1.toLowerCase() === currentAccount.toLowerCase(); });
    }, 5);
    // avisar por la campanita de World App a los suscritos (menos al creador)
    try {
      fetch('/api/worldNotify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reto', handle: currentUserHandle || 'un jugador', stake: String(stakeWldStr), fromWallet: currentAccount })
      }).catch(function(){});
    } catch (e2) {}
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
    damasWaitLobby(function (open) {
      return !(open || []).some(function (g) { return String(g.id) === String(id); });
    }, 5);
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
    let emotesSeen = 0;
    for (const em of ((sj && sj.emotes) || [])) if (em && typeof em.ts === 'number') emotesSeen = Math.max(emotesSeen, em.ts);
    damasCurrentGame = { id, me: side, p1: g0.p1, p2: g0.p2, stake: g0.stake, status: g0.status, board, turn, log, selected: null, settling: false, emotesSeen, draw: (sj && sj.drawProposal) || null };
    const damasBox = document.getElementById('damasActionsBox');
    if (damasBox) { damasBox.innerHTML = ''; delete damasBox.dataset.draw; }
    document.getElementById('damasLobbyView').style.display = 'none';
    document.getElementById('damasBoardView').style.display = 'block'; (function(){var x=document.getElementById('damasHead'); if(x) x.style.display='none';})();
    damasRenderBoard();
    if (damasCurrentGame.draw) damasRenderDrawBanner();
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
  document.getElementById('damasBoardView').style.display = 'none'; (function(){var x=document.getElementById('damasHead'); if(x) x.style.display='';})();
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
    damasHandleEmotes(j && j.emotes);
    damasHandleDrawProposal(j && j.drawProposal);
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
  // jugadas legales del turno actual (para pintar pistas)
  const legal = g.turn === g.me ? damasLegalMoves(g.board, g.me) : [];
  const targets = new Map(); // sq destino -> capturas
  for (const m of legal) if (g.selected === m.from) targets.set(m.to, m.captures.length);
  let html = '<div class="damas-grid">';
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const row = flip ? 7 - rr : rr;
      const col = flip ? 7 - cc : cc;
      const dark = (row + col) % 2 === 1;
      const sq = dark ? rcToSq(row, col) : -1;
      const piece = sq >= 0 ? g.board[sq] : 0;
      const sel = g.selected === sq;
      const hint = sq >= 0 && targets.has(sq);
      let inner = '';
      if (piece) {
        const cls = isP1(piece) ? 'damas-p1' : 'damas-p2';
        inner = `<div class="damas-piece ${cls}${isKing(piece) ? ' damas-king' : ''}">${isKing(piece) ? '<div class="damas-crown">👑</div>' : ''}</div>`;
      }
      if (hint) inner += '<div class="damas-hint"></div>';
      html += `<div class="damas-sq ${dark ? 'dark' : 'light'}${sel ? ' sel' : ''}" ${sq >= 0 ? `onclick="damasClickSquare(${sq})"` : ''}>${inner}</div>`;
    }
  }
  html += '</div>';
  const turnTxt = g.settling ? '🏆 Fin de la partida' : (g.turn === g.me ? '🟢 Tu turno' : '⏳ Turno del rival');
  const tEl = document.getElementById('damasTurnInfo');
  if (tEl) tEl.textContent = turnTxt;
  el.innerHTML = html;
  damasUpdateHeader();
}

function damasShortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '?'; }

// encabezado con jugadores, bote, capturadas y turno iluminado
function damasUpdateHeader() {
  const g = damasCurrentGame;
  if (!g) return;
  const p1Name = document.getElementById('damasP1Name');
  const p2Name = document.getElementById('damasP2Name');
  if (p1Name) p1Name.textContent = damasShortAddr(g.p1) + (g.me === 'p1' ? ' (tú)' : '');
  if (p2Name) p2Name.textContent = damasShortAddr(g.p2) + (g.me === 'p2' ? ' (tú)' : '');
  const a1 = document.getElementById('damasP1Avatar'); if (a1) a1.textContent = (g.p1 || '?').slice(2, 3).toUpperCase();
  const a2 = document.getElementById('damasP2Avatar'); if (a2) a2.textContent = (g.p2 || '?').slice(2, 3).toUpperCase();
  const capP1 = 12 - damasCountSide(g.board, 'p2'); // piezas que p1 comio
  const capP2 = 12 - damasCountSide(g.board, 'p1');
  const m1 = document.getElementById('damasP1Meta'); if (m1) m1.innerHTML = `<span class="damas-chip">${damasFmtWld(g.stake)} WLD</span>Capturadas: ${capP1}`;
  const m2 = document.getElementById('damasP2Meta'); if (m2) m2.innerHTML = `<span class="damas-chip">${damasFmtWld(g.stake)} WLD</span>Capturadas: ${capP2}`;
  const pot = document.getElementById('damasPotAmt'); if (pot) pot.textContent = damasFmtWld((BigInt(g.stake) * 2n).toString()) + ' WLD';
  const c1 = document.getElementById('damasP1Card');
  const c2 = document.getElementById('damasP2Card');
  if (c1) c1.classList.toggle('turn', !g.settling && g.turn === 'p1');
  if (c2) c2.classList.toggle('turn', !g.settling && g.turn === 'p2');
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
  damasRenderBoard();
  damasShowConfirmBtn(winnerAddr, winnerSide);
}

function damasShowConfirmBtn(winnerAddr, winnerSide) {
  const g = damasCurrentGame;
  const box = document.getElementById('damasActionsBox');
  if (!box || !g) return;
  const potWei = (BigInt(g.stake) * 2n).toString();
  const feeWei = (BigInt(potWei) * 100n / 10000n).toString(); // 1% flat
  const payWei = (BigInt(potWei) - BigInt(feeWei)).toString();
  const win = winnerSide === g.me;
  box.innerHTML = `
    <div class="damas-breakdown">
      <div style="font-size:16px;font-weight:900">${win ? '🏆 ¡Ganaste!' : '😔 Ganó el rival'}</div>
      <div class="small" style="margin:4px 0 8px">Confirmá el resultado para liquidar el pozo en cadena.</div>
      <div class="row"><span>Bote total</span><b>${damasFmtWld(potWei)} WLD</b></div>
      <div class="row"><span>Comisión Dragon Trade (1%)</span><b>${damasFmtWld(feeWei)} WLD</b></div>
      <div class="row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px"><span>Recibe el ganador</span><b>${damasFmtWld(payWei)} WLD</b></div>
      <button class="btnY" style="margin-top:10px;width:100%" onclick="damasConfirmResult('${winnerAddr}')">✅ Confirmar resultado y cobrar</button>
    </div>`;
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
      if (g.draw && g.draw.status === 'accepted' && box) {
        box.innerHTML = `
          <div class="damas-breakdown">
            <div style="font-size:15px;font-weight:900;color:var(--green)">🤝 Tablas confirmadas. Partida terminada.</div>
            <div class="row" style="margin-top:6px"><span>Recibe cada jugador (menos comisión)</span><b>${damasFmtWld((BigInt(g.stake) * 99n / 100n).toString())} WLD</b></div>
          </div>`;
        return;
      }
      const potWei = (BigInt(g.stake) * 2n).toString();
      const payWei = (BigInt(potWei) * 99n / 100n).toString();
      if (box) box.innerHTML = `
        <div class="damas-breakdown">
          <div style="font-size:15px;font-weight:900;color:var(--green)">✅ Pozo pagado. Partida terminada.</div>
          <div class="row" style="margin-top:6px"><span>El ganador recibió</span><b>${damasFmtWld(payWei)} WLD</b></div>
          <div class="row"><span>Comisión Dragon Trade (1%)</span><b>${damasFmtWld((BigInt(potWei) - BigInt(payWei)).toString())} WLD</b></div>
        </div>`;
      return;
    }
    if (g0.status === 4) { damasShowDispute(); return; }
    setTimeout(damasPollSettleStatus, 5000);
  } catch (e) { setTimeout(damasPollSettleStatus, 7000); }
}


// ---------------- tablas (empate: apuestas devueltas sin comision) ----------------
function damasHandleDrawProposal(p) {
  const g = damasCurrentGame;
  if (!g || g.settling) return;
  if (JSON.stringify(p || null) === JSON.stringify(g.draw)) return;
  g.draw = p || null;
  damasRenderDrawBanner();
}

function damasRenderDrawBanner() {
  const g = damasCurrentGame;
  if (!g) return;
  const box = document.getElementById('damasActionsBox');
  if (!box) return;
  if (!g.draw) {
    if (box.dataset.draw === '1') { box.innerHTML = ''; delete box.dataset.draw; }
    return;
  }
  box.dataset.draw = '1';
  const p = g.draw;
  if (p.status === 'proposed' && p.by !== g.me) {
    box.innerHTML = `
      <div class="damas-breakdown">
        <div style="font-size:15px;font-weight:900">🤝 Tu rival propone tablas</div>
        <div class="small" style="margin:4px 0 8px">Si aceptás, ambos reciben su apuesta menos 1% de comisión del pozo (repartida).</div>
        <button class="btnY" style="width:100%" onclick="damasRespondDraw(true)">🤝 Aceptar tablas</button>
        <button class="btnY" style="background:var(--card2);color:#eaecef;width:100%;margin-top:8px" onclick="damasRespondDraw(false)">⚔️ Seguir jugando</button>
      </div>`;
  } else if (p.status === 'proposed' && p.by === g.me) {
    box.innerHTML = `
      <div class="damas-breakdown">
        <div style="font-size:15px;font-weight:900">🤝 Tablas propuestas</div>
        <div class="small" style="margin:4px 0">Esperando la respuesta del rival...</div>
      </div>`;
  } else if (p.status === 'accepted') {
    box.innerHTML = `
      <div class="damas-breakdown">
        <div style="font-size:15px;font-weight:900">🤝 Tablas aceptadas</div>
        <div class="small" style="margin:4px 0 8px">Confirmá en cadena para que ambos reciban su apuesta menos la comisión.</div>
        <button class="btnY" style="width:100%" onclick="damasConfirmDraw()">✅ Confirmar tablas</button>
      </div>`;
  }
}

async function damasProposeDraw() {
  const g = damasCurrentGame;
  if (!g) return;
  try {
    const r = await fetch(DAMAS_MOVES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'proposedraw', gameId: g.id, by: g.me }) });
    const j = await r.json();
    if (j.ok) { g.draw = j.drawProposal; damasRenderDrawBanner(); showOk('Propuesta enviada al rival', '🤝'); }
    else showOk(j.error || 'No se pudo proponer', '⚠️');
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

async function damasRespondDraw(accept) {
  const g = damasCurrentGame;
  if (!g) return;
  try {
    const r = await fetch(DAMAS_MOVES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'responddraw', gameId: g.id, by: g.me, accept }) });
    const j = await r.json();
    if (!j.ok) return showOk(j.error || 'Error', '⚠️');
    g.draw = j.drawProposal || null;
    if (accept) {
      showOk('Confirmando las tablas en World App...', '⏳');
      await damasConfirmDraw();
    } else {
      damasRenderDrawBanner();
      showOk('Seguís jugando. ¡Éxito!', '⚔️');
    }
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

async function damasConfirmDraw() {
  const g = damasCurrentGame;
  if (!g) return;
  try {
    await damasSendTx([{ to: DAMAS_ADDRESS, data: encConfirmResult(g.id, '0x' + '0'.repeat(40)), value: '0x0' }], 'Confirmando tablas en World App...');
    showOk('Tablas confirmadas. Cuando el rival confirme, ambos reciben su apuesta.', '⏳');
    damasPollSettleStatus();
  } catch (e) { showOk('Error: ' + (e.message || e), '❌'); }
}

function damasShowDispute() {
  const box = document.getElementById('damasActionsBox');
  if (box) box.innerHTML = '<div class="damas-muted err">⚠️ Los dos jugadores confirmaron resultados distintos. Dragon Trade revisará y arbitrará el pozo.</div>';
}

async function damasResign() {
  const g = damasCurrentGame;
  if (!g || !(await damasAsk('🏳️ ¿Seguro que te rendís?\nEl rival se queda con todo el pozo.', 'Sí, rendirme', 'Continuar jugando'))) return;
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

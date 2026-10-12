// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// DamasPot — juego de Damas P2P de Dragon Trade (World Chain).
// Cada jugador bloquea la misma apuesta en WLD (pozo comun en cadena);
// al terminar, el ganador se lleva el pozo menos 1% de comision.
// Dragon Trade Labs (owner) solo configura la comision y arbitra disputas
// raras; no toca fondos de partidas normales y no participa en las partidas.
//
// Flujo:
//   1. createGame(stake)  -> jugador 1 bloquea su WLD, reto abierto
//   2. joinGame(id)        -> jugador 2 bloquea lo mismo, empieza la partida
//   3. (los movimientos van por la app, fuera de cadena: sin gas por jugada)
//   4. Al terminar, CADA jugador manda su propia transaccion normal
//      confirmResult(id, winner) con quien creyo que ganó. Si ambos
//      coinciden, el contrato paga solo. Esto funciona con cualquier wallet
//      (incluidas las smart wallets de World App), sin firmas off-chain.
//        - Si los dos coinciden -> pago automatico.
//        - Si no coinciden (alguien hizo trampa) -> queda en disputa;
//          Dragon Trade Labs puede arbitrar (arbitrate) como ultimo recurso.
//        - resign(id): el que se rinde pierde; el otro cobra directo.
//        - claimTimeout(id): si el rival desaparece, a las 72h de la ultima
//          actividad en cadena (touch/voto) el otro jugador cobra.
//   5. touch(id): cada navegador lo llama al abrir una partida activa para
//      demostrar que el jugador sigue presente (protege contra timeout injusto).

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract DamasPot {
    IERC20 public immutable wld;
    address public owner;
    uint256 public feeBps = 100;               // 1% flat para Dragon Trade Labs
    address public feeWallet;                  // misma wallet de comisiones del swap
    uint256 public constant MIN_STAKE = 1e18;   // 1 WLD
    uint256 public constant MAX_STAKE = 1000e18; // tope de seguridad on-chain
    uint256 public constant TIMEOUT = 72 hours;

    enum Status { None, Open, Active, Finished, Disputed }

    struct Game {
        address p1;
        address p2;
        uint256 stake;
        Status status;
        uint256 lastTouch;
        address p1Vote; // address(1) = sin votar aun (0x0 es un resultado valido: empate)
        address p2Vote;
    }

    address constant NO_VOTE = address(1);

    mapping(uint256 => Game) public games;
    uint256 public gameCount;

    event GameCreated(uint256 indexed id, address indexed p1, uint256 stake);
    event GameJoined(uint256 indexed id, address indexed p2);
    event Touched(uint256 indexed id, address indexed who);
    event ResultVoted(uint256 indexed id, address indexed who, address winner);
    event GameSettled(uint256 indexed id, address indexed winner, uint256 payout, uint256 fee);
    event GameDisputed(uint256 indexed id, address p1Vote, address p2Vote);
    event GameCancelled(uint256 indexed id);
    event FeeUpdated(uint256 bps);

    constructor(address _wld, address _feeWallet) {
        wld = IERC20(_wld);
        feeWallet = _feeWallet;
        owner = msg.sender;
    }

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    // ---------- creacion / union ----------

    function createGame(uint256 stake) external returns (uint256 id) {
        require(stake >= MIN_STAKE && stake <= MAX_STAKE, "apuesta fuera de rango");
        require(wld.transferFrom(msg.sender, address(this), stake), "transfer fallo");
        id = ++gameCount;
        games[id] = Game(msg.sender, address(0), stake, Status.Open, block.timestamp, NO_VOTE, NO_VOTE);
        emit GameCreated(id, msg.sender, stake);
    }

    function joinGame(uint256 id) external {
        Game storage g = games[id];
        require(g.status == Status.Open, "reto no abierto");
        require(msg.sender != g.p1, "no podes unirte a tu reto");
        require(wld.transferFrom(msg.sender, address(this), g.stake), "transfer fallo");
        g.p2 = msg.sender;
        g.status = Status.Active;
        g.lastTouch = block.timestamp;
        emit GameJoined(id, msg.sender);
    }

    function cancelGame(uint256 id) external {
        Game storage g = games[id];
        require(g.status == Status.Open, "solo retos sin rival");
        require(msg.sender == g.p1, "solo el creador");
        require(wld.transfer(g.p1, g.stake), "devolucion fallo");
        g.status = Status.Finished;
        emit GameCancelled(id);
    }

    // ---------- durante la partida ----------

    function touch(uint256 id) external {
        Game storage g = games[id];
        require(g.status == Status.Active, "partida no activa");
        require(msg.sender == g.p1 || msg.sender == g.p2, "no eres jugador");
        g.lastTouch = block.timestamp;
        emit Touched(id, msg.sender);
    }

    // ---------- finalizacion: cada jugador vota el resultado con su propia tx ----------

    function confirmResult(uint256 id, address winner) external {
        Game storage g = games[id];
        require(g.status == Status.Active, "partida no activa");
        require(msg.sender == g.p1 || msg.sender == g.p2, "no eres jugador");
        require(winner == g.p1 || winner == g.p2 || winner == address(0), "ganador invalido");

        if (msg.sender == g.p1) g.p1Vote = winner; else g.p2Vote = winner;
        g.lastTouch = block.timestamp;
        emit ResultVoted(id, msg.sender, winner);

        if (g.p1Vote != NO_VOTE && g.p2Vote != NO_VOTE) {
            if (g.p1Vote == g.p2Vote) {
                _finish(id, g.p1Vote);
            } else {
                g.status = Status.Disputed;
                emit GameDisputed(id, g.p1Vote, g.p2Vote);
            }
        }
    }

    function resign(uint256 id) external {
        Game storage g = games[id];
        require(g.status == Status.Active, "partida no activa");
        require(msg.sender == g.p1 || msg.sender == g.p2, "no eres jugador");
        _finish(id, _other(g, msg.sender));
    }

    function claimTimeout(uint256 id) external {
        Game storage g = games[id];
        require(g.status == Status.Active, "partida no activa");
        require(msg.sender == g.p1 || msg.sender == g.p2, "no eres jugador");
        require(block.timestamp >= g.lastTouch + TIMEOUT, "rival aun activo");
        // El que reclama es el que sigue presente: cobra el pozo (menos comision).
        _finish(id, msg.sender);
    }

    // Ultimo recurso si los jugadores votaron distinto (alguien hizo trampa).
    // Dragon Trade Labs decide con la evidencia que le compartan los jugadores.
    function arbitrate(uint256 id, address winner) external onlyOwner {
        Game storage g = games[id];
        require(g.status == Status.Disputed, "no esta en disputa");
        require(winner == g.p1 || winner == g.p2 || winner == address(0), "ganador invalido");
        _finish(id, winner);
    }

    // ---------- internos ----------

    function _finish(uint256 id, address winner) internal {
        Game storage g = games[id];
        g.status = Status.Finished;
        if (winner == address(0)) {
            // empate: la partida si se jugo, la comision se cobra igual (repartida mitad y mitad)
            uint256 pot = g.stake * 2;
            uint256 fee = (pot * feeBps) / 10000;
            require(wld.transfer(g.p1, g.stake - fee + fee / 2), "reembolso p1 fallo");
            require(wld.transfer(g.p2, g.stake - fee / 2), "reembolso p2 fallo");
            if (fee > 0) require(wld.transfer(feeWallet, fee), "comision fallo");
            emit GameSettled(id, address(0), pot - fee, fee);
        } else {
            uint256 pot = g.stake * 2;
            uint256 fee = (pot * feeBps) / 10000;
            require(wld.transfer(winner, pot - fee), "pago fallo");
            if (fee > 0) require(wld.transfer(feeWallet, fee), "comision fallo");
            emit GameSettled(id, winner, pot - fee, fee);
        }
    }

    function _other(Game storage g, address who) internal view returns (address) {
        return who == g.p1 ? g.p2 : g.p1;
    }

    // ---------- admin (solo comision / wallet / disputas, nunca fondos normales) ----------

    function setFee(uint256 bps) external onlyOwner {
        require(bps <= 500, "max 5%");
        feeBps = bps;
        emit FeeUpdated(bps);
    }

    function setFeeWallet(address w) external onlyOwner {
        require(w != address(0), "cero");
        feeWallet = w;
    }
}

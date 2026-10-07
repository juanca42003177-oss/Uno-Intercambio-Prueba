// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// DamasPot — juego de Damas P2P de Dragon Trade (World Chain).
// Cada jugador bloquea la misma apuesta en WLD (pozo comun en cadena);
// al terminar, el ganador se lleva el pozo menos 1% de comision.
// Dragon Trade Labs (owner) solo configura la comision; no toca fondos
// de partidas activas y no participa en las partidas.
//
// Flujo:
//   1. createGame(stake)  -> jugador 1 bloquea su WLD, reto abierto
//   2. joinGame(id)        -> jugador 2 bloquea lo mismo, empieza la partida
//   3. (los movimientos van por la app, fuera de cadena: sin gas por jugada)
//   4. Al terminar:
//        - settle(id, winner, sig1, sig2): ambos firman el resultado y el
//          contrato paga al ganador (winner = 0x0 = empate, reembolso).
//        - resign(id): el que se rinde pierde; el otro cobra directo.
//        - claimTimeout(id): si el rival desaparece, a las 72h de la ultima
//          actividad en cadena (touch) el otro jugador cobra.
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

    enum Status { None, Open, Active, Finished }

    struct Game {
        address p1;
        address p2;
        uint256 stake;
        Status status;
        uint256 lastTouch;
    }

    mapping(uint256 => Game) public games;
    uint256 public gameCount;

    event GameCreated(uint256 indexed id, address indexed p1, uint256 stake);
    event GameJoined(uint256 indexed id, address indexed p2);
    event Touched(uint256 indexed id, address indexed who);
    event GameSettled(uint256 indexed id, address indexed winner, uint256 payout, uint256 fee);
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
        games[id] = Game(msg.sender, address(0), stake, Status.Open, block.timestamp);
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

    // ---------- finalizacion ----------

    // Resultado firmado por AMBOS jugadores: winner = p1, p2 o 0x0 (empate).
    // Mensaje firmado (EIP-191): keccak256(abi.encodePacked("DAMAS#", id, "#", winner))
    function settle(uint256 id, address winner, bytes calldata sig1, bytes calldata sig2) external {
        Game storage g = games[id];
        require(g.status == Status.Active, "partida no activa");
        require(msg.sender == g.p1 || msg.sender == g.p2, "no eres jugador");
        require(winner == g.p1 || winner == g.p2 || winner == address(0), "ganador invalido");
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",
            keccak256(abi.encodePacked("DAMAS#", id, "#", winner))));
        require(_recover(digest, sig1) == g.p1, "firma 1 invalida");
        require(_recover(digest, sig2) == g.p2, "firma 2 invalida");
        _finish(id, winner);
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
        _finish(id, _other(g, msg.sender));
    }

    // ---------- internos ----------

    function _finish(uint256 id, address winner) internal {
        Game storage g = games[id];
        g.status = Status.Finished;
        if (winner == address(0)) {
            // empate: reembolso integro a ambos, sin comision
            require(wld.transfer(g.p1, g.stake), "reembolso p1 fallo");
            require(wld.transfer(g.p2, g.stake), "reembolso p2 fallo");
            emit GameSettled(id, address(0), 0, 0);
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

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "firma invalida");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }

    // ---------- admin (solo comision / wallet, nunca fondos de partidas) ----------

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

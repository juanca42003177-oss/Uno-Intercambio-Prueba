// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UNO PREDICT — Mercado de predicción TRANSPARENTE de Uno Trading
// ------------------------------------------------------------
// * Se crea un mercado por token: "¿El precio de DNA estará más alto
//   o más bajo al final?" (se puede crear para CUALQUIER token de la app).
// * Los usuarios apuestan en USDC a ALZA o BAJA. Todo el dinero va a
//   un POZO COMÚN visible en cadena — no hay banca.
// * Al resolverse, el lado que acertó se reparte el pozo completo
//   en proporción a lo que apostó cada quien. El lado que falló no
//   recibe nada. Juan cobra 1% del pozo por crear y resolver el
//   mercado. Nada más.
// * REGLAS EN CADENA, visibles para todos: ventanas de apuesta y
//   de resolución, tamaño del pozo, apuestas de cada uno.
// * Resolución v1: la firma Juan (resolver) con el precio de
//   referencia público (Dexscreener/explorer) en el momento exacto
//   resolveAt. Fase 2b: oráculo automático.
// ============================================================

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract UnoPredict {
    IERC20  public immutable betToken;   // USDC — moneda de apuesta
    address public immutable feeWallet;  // wallet de comisiones de Juan
    address public immutable resolver;   // Juan (fase 2b: oráculo)

    uint256 public constant FEE_BPS   = 100;   // 1% del pozo total
    uint256 public constant MIN_BET   = 10e6;  // $10 USDC mínimo por apuesta
    uint64  public constant MIN_MARKET_DURATION = 2 minutes; // apuestas mínimas

    struct Market {
        string  label;        // ej. "DNA sube o baja — 5 minutos"
        uint64  betDeadline;  // hasta cuándo se puede apostar
        uint64  resolveAt;    // momento del precio de referencia
        uint256 totalUp;
        uint256 totalDown;
        bool    resolved;
        bool    upWon;
        bool    noWinners;    // todos apostaron al mismo lado → devoluciones
        uint256 potAfterFee;  // pozo repartible (ya sin la comisión de 1%)
    }

    Market[] public markets;
    mapping(uint256 => mapping(address => uint256)) public betsUp;
    mapping(uint256 => mapping(address => uint256)) public betsDown;

    event MarketCreated(uint256 indexed id, string label, uint64 betDeadline, uint64 resolveAt);
    event BetPlaced(uint256 indexed id, address indexed user, bool up, uint256 amount);
    event MarketResolved(uint256 indexed id, bool upWon, uint256 pot, uint256 fee);
    event Claimed(uint256 indexed id, address indexed user, uint256 amount);

    error NotResolver();
    error BetsClosed();
    error AlreadyResolved();
    error NotResolvedYet();
    error TooSmall();
    error NothingToClaim();
    error TransferFailed();
    error BadWindows();

    modifier onlyResolver() { if (msg.sender != resolver) revert NotResolver(); _; }

    constructor(address _betToken, address _feeWallet) {
        betToken  = IERC20(_betToken);
        feeWallet = _feeWallet;
        resolver  = msg.sender; // Juan despliega el contrato
    }

    // ---------------- CREAR MERCADO (Juan) ----------------
    function createMarket(
        string calldata label,
        uint64 betDeadline,  // fecha límite para apostar (unix)
        uint64 resolveAt     // momento del precio de referencia (unix)
    ) external onlyResolver returns (uint256 id) {
        if (resolveAt < betDeadline + MIN_MARKET_DURATION) revert BadWindows();
        id = markets.length;
        markets.push(Market({
            label: label,
            betDeadline: betDeadline,
            resolveAt: resolveAt,
            totalUp: 0,
            totalDown: 0,
            resolved: false,
            upWon: false,
            noWinners: false,
            potAfterFee: 0
        }));
        emit MarketCreated(id, label, betDeadline, resolveAt);
    }

    // ---------------- APOSTAR (cualquier usuario) ----------------
    function bet(uint256 marketId, bool up, uint256 amount) external {
        Market storage m = markets[marketId];
        if (block.timestamp > m.betDeadline) revert BetsClosed();
        if (m.resolved) revert AlreadyResolved();
        if (amount < MIN_BET) revert TooSmall();

        if (!betToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        if (up) {
            m.totalUp += amount;
            betsUp[marketId][msg.sender] += amount;
        } else {
            m.totalDown += amount;
            betsDown[marketId][msg.sender] += amount;
        }
        emit BetPlaced(marketId, msg.sender, up, amount);
    }

    // ---------------- RESOLVER (Juan, con precio público) ----------------
    function resolve(uint256 marketId, bool upWon) external onlyResolver {
        Market storage m = markets[marketId];
        if (block.timestamp < m.resolveAt) revert NotResolvedYet();
        if (m.resolved) revert AlreadyResolved();

        m.resolved = true;
        m.upWon = upWon;

        uint256 pot = m.totalUp + m.totalDown;
        uint256 winningTotal = upWon ? m.totalUp : m.totalDown;

        if (winningTotal == 0) {
            // nadie apostó al lado ganador → devoluciones totales
            m.noWinners = true;
            m.potAfterFee = pot; // el pozo completo se devuelve, sin comisión
        } else {
            uint256 fee = (pot * FEE_BPS) / 10000; // 1% una sola vez
            m.potAfterFee = pot - fee;
            if (fee > 0 && !betToken.transfer(feeWallet, fee)) revert TransferFailed();
        }
        emit MarketResolved(marketId, upWon, pot, m.noWinners ? 0 : (pot * FEE_BPS) / 10000);
    }

    // ---------------- COBRAR PREMIO ----------------
    // Los ganadores reclaman su parte proporcional del pozo.
    // En modo devolución (noWinners) todos reciben su apuesta de vuelta.
    function claim(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (!m.resolved) revert NotResolvedYet();

        uint256 myStake = 0;
        if (m.noWinners) {
            myStake = betsUp[marketId][msg.sender] + betsDown[marketId][msg.sender];
            betsUp[marketId][msg.sender] = 0;
            betsDown[marketId][msg.sender] = 0;
        } else if (m.upWon) {
            myStake = betsUp[marketId][msg.sender];
            betsUp[marketId][msg.sender] = 0;
        } else {
            myStake = betsDown[marketId][msg.sender];
            betsDown[marketId][msg.sender] = 0;
        }
        if (myStake == 0) revert NothingToClaim();

        uint256 amount;
        if (m.noWinners) {
            amount = myStake; // devolución íntegra
        } else {
            uint256 winningTotal = m.upWon ? m.totalUp : m.totalDown;
            amount = (m.potAfterFee * myStake) / winningTotal;
        }
        if (amount > 0 && !betToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(marketId, msg.sender, amount);
    }

    // ---------------- VISTAS ----------------
    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function myBet(uint256 marketId, address user)
        external view returns (uint256 up, uint256 down)
    {
        return (betsUp[marketId][user], betsDown[marketId][user]);
    }

    function marketSummary(uint256 marketId)
        external view returns (
            string memory label, uint64 betDeadline, uint64 resolveAt,
            uint256 totalUp, uint256 totalDown, bool resolved, bool upWon, uint256 potAfterFee
        )
    {
        Market storage m = markets[marketId];
        return (m.label, m.betDeadline, m.resolveAt, m.totalUp, m.totalDown, m.resolved, m.upWon, m.potAfterFee);
    }
}

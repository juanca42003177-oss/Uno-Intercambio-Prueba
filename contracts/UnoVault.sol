// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UNO VAULT — Bóveda de staking REAL de Uno Trading (World Chain)
// ------------------------------------------------------------
// * El usuario deposita UN solo token (tokenA). El contrato cambia
//   la mitad por tokenB y mete la liquidez al pool V2 REAL de
//   Uniswap (el mismo que usa el Swap). El depósito gana las
//   comisiones REALES que cobra ese pool en cada trade.
// * Al retirar (después del bloqueo): saca la liquidez, convierte
//   todo de vuelta a tokenA y cobra 20% SOLO de la ganancia real.
//   Si hubo pérdida (el precio se movió contra el pool), el usuario
//   retira TODO sin comisión.
// * Bloqueo mínimo: 30 DÍAS, grabado en el contrato.
// * Depósito mínimo: minDeposit (~$15 en unidades de tokenA).
// * SEGURIDAD: el dueño NO puede tocar los fondos de los usuarios.
//   Solo puede pausar NUEVOS depósitos. Los retiros jamás se bloquean.
// * IMPORTANTE: usar solo con tokens SIN impuesto de transferencia
//   (AXO, WLD, CHAD...). DNA tiene impuesto 15% y necesita una
//   variante del contrato (fase 2b).
// ============================================================

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function approve(address s, uint256 a) external returns (bool);
}

interface IRouter {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory);
    function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB);
}

interface IPair {
    function token0() external view returns (address);
    function approve(address s, uint256 a) external returns (bool);
}

contract UnoVault {
    IERC20  public immutable tokenA;     // token que deposita y recibe el usuario
    IERC20  public immutable tokenB;     // el otro lado del par
    IRouter public immutable router;     // router V2 de Uniswap en World Chain
    IPair   public immutable pair;       // par V2 tokenA/tokenB (dirección real)
    address public immutable feeWallet;  // wallet de comisiones de Juan
    address public immutable owner;

    uint256 public constant PERFORMANCE_FEE_BPS = 2000; // 20% de la GANANCIA REAL
    uint256 public constant LOCK_PERIOD = 30 days;      // bloqueo mínimo OBLIGATORIO
    uint256 public constant SLIPPAGE_BPS = 300;         // 3% de protección en cambios
    uint256 public minDeposit;                          // mínimo en unidades de tokenA (~$15)

    bool public depositsPaused;

    struct Deposit {
        uint128 principalA;  // lo que depositó (en tokenA)
        uint128 liquidity;    // LP tokens que respaldan ese depósito
        uint64  unlockAt;     // depositAt + 30 días
    }

    mapping(address => Deposit[]) private _deposits;

    event Deposited(address indexed user, uint256 amountA, uint256 liquidity, uint64 unlockAt);
    event Withdrawn(address indexed user, uint256 returnedA, uint256 feeA);
    event DepositsPaused(bool paused);
    event MinDepositUpdated(uint256 newMin);

    error Paused();
    error TooSmall();
    error NotOwner();
    error StillLocked();
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(
        address _tokenA,
        address _tokenB,
        address _router,
        address _pair,
        address _feeWallet,
        uint256 _minDeposit
    ) {
        tokenA   = IERC20(_tokenA);
        tokenB   = IERC20(_tokenB);
        router   = IRouter(_router);
        pair     = IPair(_pair);
        feeWallet = _feeWallet;
        owner    = msg.sender;
        minDeposit = _minDeposit;

        // Autorizaciones fijas para siempre: tokens y LP hacia el router
        tokenA.approve(_router, type(uint256).max);
        tokenB.approve(_router, type(uint256).max);
        pair.approve(_router, type(uint256).max);
    }

    function _path() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(tokenA);
        p[1] = address(tokenB);
    }

    function _pathBack() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(tokenB);
        p[1] = address(tokenA);
    }

    // ---------------- DEPOSITAR ----------------
    function deposit(uint256 amountA) external {
        if (depositsPaused) revert Paused();
        if (amountA < minDeposit) revert TooSmall();

        // 1. recibir los tokens del usuario
        if (!tokenA.transferFrom(msg.sender, address(this), amountA)) revert TransferFailed();

        // 2. cambiar la mitad por tokenB (contabilidad EXACTA: la mitad
        //    del depósito, no saldos del contrato que puedan tener polvo)
        uint256 half = amountA / 2;
        uint256[] memory out = router.getAmountsOut(half, _path());
        uint256 minOut = (out[1] * (10000 - SLIPPAGE_BPS)) / 10000;
        uint256[] memory swapped = router.swapExactTokensForTokens(
            half, minOut, _path(), address(this), block.timestamp
        );
        uint256 gotB = swapped[swapped.length - 1];

        // 3. meter la liquidez al pool real (la mitad restante de tokenA)
        uint256 remainingA = amountA - half;
        (, , uint256 liquidityAdded) = router.addLiquidity(
            address(tokenA), address(tokenB),
            remainingA, gotB,
            (remainingA * (10000 - SLIPPAGE_BPS)) / 10000,
            (gotB * (10000 - SLIPPAGE_BPS)) / 10000,
            address(this), block.timestamp
        );

        // 4. registrar el depósito
        uint64 unlock = uint64(block.timestamp + LOCK_PERIOD);
        _deposits[msg.sender].push(Deposit({
            principalA: uint128(amountA),
            liquidity: uint128(liquidityAdded),
            unlockAt: unlock
        }));

        emit Deposited(msg.sender, amountA, liquidityAdded, unlock);
    }

    // ---------------- RETIRAR (por depósito) ----------------
    // Devuelve TODO en tokenA: principal + comisiones reales del pool.
    // Cobra 20% SOLO de la parte que supera lo depositado.
    function withdraw(uint256 depositIndex) external {
        Deposit[] storage list = _deposits[msg.sender];
        require(depositIndex < list.length, "indice invalido");
        Deposit storage d = list[depositIndex];
        if (d.liquidity == 0) revert NothingToWithdraw();
        if (block.timestamp < d.unlockAt) revert StillLocked();

        uint256 lp = d.liquidity;
        uint256 principal = d.principalA;
        d.liquidity = 0; // efecto ANTES de interacciones externas

        // 1. sacar la liquidez del pool
        (uint256 gotA, uint256 gotB) = router.removeLiquidity(
            address(tokenA), address(tokenB),
            lp, 0, 0, address(this), block.timestamp
        );

        // 2. convertir TODO el tokenB de vuelta a tokenA (contabilidad exacta)
        uint256 totalA = gotA;
        if (gotB > 0) {
            uint256[] memory out = router.getAmountsOut(gotB, _pathBack());
            uint256 minOut = (out[1] * (10000 - SLIPPAGE_BPS)) / 10000;
            uint256[] memory res = router.swapExactTokensForTokens(
                gotB, minOut, _pathBack(), address(this), block.timestamp
            );
            totalA += res[res.length - 1];
        }

        // 3. comisión SOLO si hay ganancia real sobre lo depositado
        uint256 feeA = 0;
        if (totalA > principal) {
            feeA = ((totalA - principal) * PERFORMANCE_FEE_BPS) / 10000;
        }
        uint256 returnToUser = totalA - feeA;

        if (feeA > 0 && !tokenA.transfer(feeWallet, feeA)) revert TransferFailed();
        if (!tokenA.transfer(msg.sender, returnToUser)) revert TransferFailed();

        emit Withdrawn(msg.sender, returnToUser, feeA);
    }

    // ---------------- VISTAS ----------------
    function depositsLength(address user) external view returns (uint256) {
        return _deposits[user].length;
    }

    function depositInfo(address user, uint256 index)
        external view returns (uint256 principalA, uint256 liquidity, uint64 unlockAt, bool unlocked)
    {
        Deposit storage d = _deposits[user][index];
        return (d.principalA, d.liquidity, d.unlockAt, block.timestamp >= d.unlockAt && d.liquidity > 0);
    }

    // ---------------- ADMIN (limitado a propósito) ----------------
    // El dueño JAMÁS puede mover fondos de los usuarios. Solo puede
    // pausar NUEVOS depósitos y ajustar el mínimo de entrada.
    function setDepositsPaused(bool p) external onlyOwner {
        depositsPaused = p;
        emit DepositsPaused(p);
    }

    function setMinDeposit(uint256 v) external onlyOwner {
        minDeposit = v;
        emit MinDepositUpdated(v);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UNO VAULT TAX (variante 2b) — Bóveda para tokens CON IMPUESTO
// (DNA 15%). Igual que UnoVault pero con contabilidad basada en
// saldos reales: nunca asume que lo que llega es lo declarado.
// 20% SOLO sobre ganancia • bloqueo 30 días • dueño no toca fondos
// ============================================================

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IRouterTax {
    // versión que soporta tokens con impuesto en transferencia
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn, uint amountOutMin, address[] calldata path,
        address to, uint deadline
    ) external;
    function addLiquidity(
        address tokenA, address tokenB, uint amountADesired, uint amountBDesired,
        uint amountAMin, uint amountBMin, address to, uint deadline
    ) external returns (uint amountA, uint amountB, uint liquidity);
    function removeLiquidity(
        address tokenA, address tokenB, uint liquidity, uint amountAMin,
        uint amountBMin, address to, uint deadline
    ) external returns (uint amountA, uint amountB);
    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
}

interface IPair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

contract UnoVaultTax {
    uint256 public constant PERFORMANCE_FEE_BPS = 2000; // 20% SOLO sobre ganancia
    uint256 public constant LOCK_PERIOD = 30 days;
    uint256 public constant SLIPPAGE_BPS = 2000; // 20% de tolerancia (cubre el impuesto 15% de DNA)

    address public owner;
    uint256 public minDeposit;
    bool public depositsPaused;
    address public feeWallet;

    IERC20  public immutable tokenA; // token con impuesto (DNA)
    IERC20  public immutable tokenB; // ETH/WETH
    IRouterTax public immutable router;
    IPair   public immutable pair;

    struct Deposit {
        uint256 principalA;  // lo que REALMENTE llegó al contrato (post-impuesto)
        uint256 liquidity;
        uint64  unlockAt;
        bool    unlocked;
    }

    mapping(address => Deposit[]) public deposits;

    event Deposited(address indexed user, uint256 receivedA, uint256 liquidity, uint64 unlockAt);
    event Withdrawn(address indexed user, uint256 returnedA, uint256 feeA);
    event MinDepositUpdated(uint256 newMin);
    event DepositsPaused(bool paused);

    error NotOwner();
    error TooSmall();
    error StillLocked();
    error NothingToWithdraw();
    error Paused();
    error NothingReceived();

    constructor(
        address _tokenA,
        address _tokenB,
        address _router,
        address _pair,
        address _feeWallet,
        uint256 _minDeposit
    ) {
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
        router = IRouterTax(_router);
        pair   = IPair(_pair);
        feeWallet = _feeWallet;
        minDeposit = _minDeposit;
        owner = msg.sender;

        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------
    // DEPOSITAR: contabilidad por saldos reales (post-impuesto)
    // ---------------------------------------------------------
    function deposit(uint256 amountA) external {
        if (depositsPaused) revert Paused();
        if (amountA < minDeposit) revert TooSmall();

        uint256 beforeA = tokenA.balanceOf(address(this));

        bool ok = tokenA.transferFrom(msg.sender, address(this), amountA);
        if (!ok) revert NothingReceived();

        uint256 receivedA = tokenA.balanceOf(address(this)) - beforeA;
        if (receivedA == 0) revert NothingReceived();

        // convertir la mitad a tokenB
        uint256 half = receivedA / 2;
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);

        // cotizar con getAmountsOut y aplicar tolerancia amplia (impuesto)
        uint256[] memory amounts = router.getAmountsOut(half, path);
        uint256 minOut = (amounts[amounts.length - 1] * (10000 - SLIPPAGE_BPS)) / 10000;

        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            half, minOut, path, address(this), block.timestamp + 300
        );

        // meter liquidez con lo que REALMENTE hay
        uint256 balA = tokenA.balanceOf(address(this));
        uint256 balB = tokenB.balanceOf(address(this));

        uint256 beforeLiq = IERC20(address(pair)).balanceOf(address(this));
        router.addLiquidity(
            address(tokenA), address(tokenB),
            balA, balB, 0, 0, address(this), block.timestamp + 300
        );
        uint256 liq = IERC20(address(pair)).balanceOf(address(this)) - beforeLiq;
        require(liq > 0, "no liquidity minted");

        deposits[msg.sender].push(Deposit({
            principalA: receivedA,
            liquidity: liq,
            unlockAt: uint64(block.timestamp + LOCK_PERIOD),
            unlocked: false
        }));

        emit Deposited(msg.sender, receivedA, liq, uint64(block.timestamp + LOCK_PERIOD));
    }

    // ---------------------------------------------------------
    // RETIRAR: mide todo por saldos reales, 20% solo sobre ganancia
    // ---------------------------------------------------------
    function withdraw(uint256 depositIndex) external {
        Deposit storage d = deposits[msg.sender][depositIndex];
        if (d.unlocked) revert NothingToWithdraw();
        if (block.timestamp < d.unlockAt) revert StillLocked();

        d.unlocked = true;

        // sacar la LP del pool
        router.removeLiquidity(
            address(tokenA), address(tokenB),
            d.liquidity, 0, 0, address(this), block.timestamp + 300
        );

        // convertir TODO el tokenB de vuelta a tokenA
        uint256 usableB = tokenB.balanceOf(address(this));

        if (usableB > 0) {
            address[] memory path = new address[](2);
            path[0] = address(tokenB);
            path[1] = address(tokenA);
            uint256[] memory amounts = router.getAmountsOut(usableB, path);
            uint256 minOut = (amounts[amounts.length - 1] * (10000 - SLIPPAGE_BPS)) / 10000;

            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                usableB, minOut, path, address(this), block.timestamp + 300
            );
        }

        // lo que realmente hay ahora vs lo que el usuario puso
        uint256 totalA = tokenA.balanceOf(address(this));
        if (totalA > d.principalA) {
            uint256 gain = totalA - d.principalA;
            uint256 fee = (gain * PERFORMANCE_FEE_BPS) / 10000;
            uint256 toUser = totalA - fee;

            if (fee > 0) {
                bool sentFee = tokenA.transfer(feeWallet, fee);
                if (!sentFee) revert NothingReceived();
            }
            bool sent = tokenA.transfer(msg.sender, toUser);
            if (!sent) revert NothingReceived();

            emit Withdrawn(msg.sender, toUser, fee);
        } else {
            // no hubo ganancia: no se cobra nada
            bool sent = tokenA.transfer(msg.sender, totalA);
            if (!sent) revert NothingReceived();
            emit Withdrawn(msg.sender, totalA, 0);
        }
    }

    // ---------------------------------------------------------
    // Vistas
    // ---------------------------------------------------------
    function depositsLength(address user) external view returns (uint256) {
        return deposits[user].length;
    }

    function depositInfo(address user, uint256 index) external view
        returns (uint256 principalA, uint256 liquidity, uint64 unlockAt, bool unlocked)
    {
        Deposit memory d = deposits[user][index];
        return (d.principalA, d.liquidity, d.unlockAt, d.unlocked);
    }

    // ---------------------------------------------------------
    // Admin (solo dueño, nunca toca fondos)
    // ---------------------------------------------------------
    function setMinDeposit(uint256 v) external onlyOwner {
        minDeposit = v;
        emit MinDepositUpdated(v);
    }

    function setDepositsPaused(bool p) external onlyOwner {
        depositsPaused = p;
        emit DepositsPaused(p);
    }
}

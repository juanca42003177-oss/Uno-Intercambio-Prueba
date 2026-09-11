# 📦 Contratos de Uno Trading — Guía de despliegue (World Chain)

Ambos contratos compilan limpios con Solidity 0.8.20. Se despliegan UNA sola vez.

## Reglas grabadas en los contratos
| Regla | Valor |
|---|---|
| Comisión bóveda | 20% SOLO de la ganancia real (performance fee) |
| Bloqueo mínimo bóveda | 30 días exactos, nadie puede saltarlo |
| Depósito mínimo bóveda | ~$15 en unidades del token (parámetro al desplegar) |
| Comisión predicción | 1% del pozo total, cobrado 1 vez al resolver |
| Apuesta mínima | $10 USDC |
| Comisión swap (ya activa) | 0.3% normal / 1% tokens difíciles |

## Paso 1 — Preparar Remix
1. Entra a https://remix.ethereum.org
2. Crea archivos `UnoVault.sol` y `UnoPredict.sol` y pega el código de este repo.
3. En la pestaña "Solidity Compiler": versión `0.8.20`, activa el optimizador (200 runs).
4. Compila cada contrato (debe decir 0 errores).

## Paso 2 — Conectar tu wallet
- En Remix, pestaña "Deploy & Run": Environment = **Injected Provider - MetaMask**.
- MetaMask: agrega la red World Chain (Chain ID 480, RPC https://worldchain-mainnet.g.alchemy.com/v2/<tu-key>, explorer https://worldscan.org).
- Necesitas un poco de WLD o ETH para el gas del despliegue (~0.01-0.05).

## Paso 3 — Desplegar UnoPredict (mercado de predicción)
Constructor: `(_betToken, _feeWallet)`
```
_betToken  = 0x79A02482A880bCE3F13e09Da970dC34db4CD24d1   (USDC)
_feeWallet = 0x019001d46cd3155ef045a41f4c359c040595438c   (tu wallet de comisiones)
```
La wallet que despliegue queda como `resolver` (tú creas y resuelves mercados).

Ejemplo CHAD/WETH (bóveda alternativa): tokenA=0x50723A159ba02A1ADA4d7E1A32835f7ff1F1bE89, tokenB=0x4200000000000000000000000000000000000006, pair=0x9e7015a5966fff35c8ad4eb17b572d7f150191e7

## Paso 4 — Desplegar UnoVault (bóveda de staking)
Constructor: `(_tokenA, _tokenB, _router, _pair, _feeWallet, _minDeposit)`

Ejemplo con el par AXO/WLD (tokens sin impuesto, par V2 real):
```
_tokenA    = 0x249820C0479D0A7feE6A2A3a14583267550F3caF   (AXO — el usuario deposita y recibe AXO)
_tokenB    = 0x2cFc85d8E48F8EAB294be644d9E25C3030863003   (WLD)
_router    = 0x541aB7c31A119441eF3575F6973277DE0eF460bd   (router V2)
_pair      = 0x79f80954984eb22dd2c63668f7c9312e883b1100   (par V2 AXO/WLD, verificado en cadena)
_feeWallet = 0x019001d46cd3155ef045a41f4c359c040595438c
_minDeposit= 15000000000000000000  (15 AXO; ajustar según el precio para que sea ~$15)
```
⚠️ Cada par necesita SU PROPIA bóveda (un contrato nuevo por par).
⚠️ NO usar la bóveda con DNA todavía (impuesto 15% rompe la contabilidad — necesita la variante fase 2b).

## Paso 5 — Después de desplegar
1. Verifica los contratos en https://worldscan.org (botón "Verify & Publish", código plano).
2. Agrega las direcciones de los contratos nuevos a la mini app "Uno Trading" en el Developer Portal.
3. Me pasas las direcciones y yo conecto la app (Bóveda y Trading dejan de ser "FASE 2").

## Seguridad incluida
- El dueño NUNCA puede mover fondos de usuarios (sin funciones de retiro ajeno).
- Los retiros de la bóveda jamás se pausan — solo se pueden pausar depósitos NUEVOS.
- Contabilidad exacta por depósito (varios depósitos por usuario, cada uno con su fecha de desbloqueo).
- Efectos antes de interacciones externas (patrón checks-effects-interactions).

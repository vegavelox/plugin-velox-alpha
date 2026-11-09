# plugin-velox-alpha

ElizaOS plugin for live crypto spot quotes and stablecoin basis, paid per call with x402 on Base. Raw quotes, not trading signals; no guarantee of availability.

| Action | What it returns | Cost |
|---|---|---|
| `GET_VELOX_FREE_REGIME_SAMPLE` | One delayed (at least 60 s) regime label for ETH, BTC, SOL. One per caller per hour. | free |
| `GET_VELOX_BASIS_QUOTES` | Live Binance/CoinDCX spot quotes and computed USDT/USDC basis | $0.03 USDC on Base |

## Install

```bash
npm install plugin-velox-alpha viem
```

```ts
import { veloxAlphaPlugin } from "plugin-velox-alpha";
// character.plugins = [veloxAlphaPlugin]
```

## Paying

Payment uses standard x402 v2 (`exact`, EIP-3009). It is gasless for the payer: no ETH is needed.

- Set `VELOX_PAYER_KEY` to a **dedicated wallet holding only a few cents of USDC**. The key stays in your process; this plugin never sends it anywhere. Signing is capped at 0.03 USDC per call.
- Without a key, the action returns `PAYMENT_REQUIRED` with the terms. Any x402 v2 client can also pay `GET /api/v1/x402/basis` directly (header `PAYMENT-SIGNATURE`).
- The older endpoints (`/api/v1/alpha/basis`, `/api/v1/oracle/*`) use a different flow: send the USDC, wait for 3 confirmations, then retry with `X-Payment-Signature` (transaction hash), `X-Payer-Timestamp` and `X-Payer-Signature` (an EIP-712 claim signed by the paying wallet). This plugin does not use them.

Set `VELOX_ORACLE_URL` to override the service host.

## Behaviour you can rely on

If the service is unreachable, rate-limited or refuses, the action returns that status (`SERVICE_UNAVAILABLE`, `RATE_LIMITED`, `REJECTED`, `ERROR`). It never returns invented or cached market values, and it makes no claim about uptime.

## License

MIT.

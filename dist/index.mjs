// src/index.ts
var DEFAULT_HOST = "https://139-59-68-105.sslip.io";
var BASE_CHAIN_ID = 8453;
var MAX_AMOUNT_UNITS = 30000n;
function host(runtime) {
  const configured = runtime?.getSetting?.("VELOX_ORACLE_URL") || process.env.VELOX_ORACLE_URL || DEFAULT_HOST;
  return String(configured).replace(/\/+$/, "");
}
function payerKey(runtime) {
  const key = runtime?.getSetting?.("VELOX_PAYER_KEY") || process.env.VELOX_PAYER_KEY;
  if (!key) return void 0;
  const hex = String(key).startsWith("0x") ? String(key) : `0x${key}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : void 0;
}
async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function describe(body) {
  const detail = body?.detail ?? body;
  return String(detail?.message || detail?.error || body?.error || (typeof body === "string" ? body : "") || "no detail").slice(0, 300);
}
async function getFreeRegimeSample(runtime) {
  try {
    const res = await fetch(`${host(runtime)}/api/v1/sample/regime`, { headers: { Accept: "application/json" } });
    const body = await readBody(res);
    if (res.ok) return { status: "SUCCESS", data: body };
    if (res.status === 429) return { status: "RATE_LIMITED", http: 429, message: describe(body) };
    if (res.status === 503) return { status: "SERVICE_UNAVAILABLE", http: 503, message: describe(body) };
    return { status: "REJECTED", http: res.status, message: describe(body) };
  } catch (error) {
    return { status: "ERROR", message: `service unreachable: ${error?.message ?? error}` };
  }
}
async function getBasisQuotes(runtime) {
  const url = `${host(runtime)}/api/v1/x402/basis`;
  try {
    const first = await fetch(url, { headers: { Accept: "application/json" } });
    if (first.ok) return { status: "SUCCESS", data: await readBody(first) };
    if (first.status !== 402) return { status: first.status === 503 ? "SERVICE_UNAVAILABLE" : "REJECTED", http: first.status, message: describe(await readBody(first)) };
    const required = await readBody(first);
    const terms = required?.accepts?.[0];
    if (!terms || required?.x402Version !== 2) return { status: "ERROR", message: "unexpected 402 body (not x402 v2)" };
    if (BigInt(terms.amount) > MAX_AMOUNT_UNITS) {
      return { status: "REJECTED", http: 402, message: `refusing to sign: ${terms.amount} units is above the ${MAX_AMOUNT_UNITS} unit cap` };
    }
    const key = payerKey(runtime);
    if (!key) {
      return {
        status: "PAYMENT_REQUIRED",
        price_units: String(terms.amount),
        asset: terms.asset,
        pay_to: terms.payTo,
        network: terms.network,
        instructions: "Set VELOX_PAYER_KEY to a dedicated Base wallet holding a few cents of USDC (no ETH needed), or use any x402 v2 client against this URL (PAYMENT-SIGNATURE header). Use a low-balance wallet only. The older endpoints instead take X-Payment-Signature (transaction hash) with X-Payer-Timestamp and X-Payer-Signature."
      };
    }
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(key);
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonce = "0x" + Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const authorization = {
      from: account.address,
      to: terms.payTo,
      value: BigInt(terms.amount),
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1e3) + (terms.maxTimeoutSeconds || 60)),
      nonce
    };
    const signature = await account.signTypedData({
      domain: { name: terms.extra?.name, version: terms.extra?.version, chainId: BASE_CHAIN_ID, verifyingContract: terms.asset },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" }
        ]
      },
      primaryType: "TransferWithAuthorization",
      message: authorization
    });
    const payment = {
      x402Version: 2,
      resource: required.resource,
      accepted: terms,
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: String(authorization.value),
          validAfter: "0",
          validBefore: String(authorization.validBefore),
          nonce
        }
      }
    };
    const paid = await fetch(url, {
      headers: { Accept: "application/json", "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payment)).toString("base64") }
    });
    const body = await readBody(paid);
    if (!paid.ok) {
      return { status: paid.status === 503 || paid.status === 502 ? "SERVICE_UNAVAILABLE" : "REJECTED", http: paid.status, message: `not delivered: ${describe(body)}` };
    }
    const receipt = paid.headers.get("PAYMENT-RESPONSE");
    return { status: "SUCCESS", data: body, settlement: receipt ? JSON.parse(Buffer.from(receipt, "base64").toString("utf8")) : void 0 };
  } catch (error) {
    return { status: "ERROR", message: `service unreachable or signing failed: ${error?.message ?? error}` };
  }
}
var veloxAlphaPlugin = {
  name: "plugin-velox-alpha",
  description: "Live crypto spot quotes and basis ($0.03 USDC per call on Base via x402) plus one free delayed regime sample per hour",
  providers: [],
  actions: [
    {
      name: "GET_VELOX_FREE_REGIME_SAMPLE",
      similes: ["FREE_REGIME_SAMPLE", "TRY_VELOX_REGIME"],
      description: "Fetch one free, delayed regime label for ETH, BTC and SOL (one per caller per hour). Delayed at least 60 seconds; not a trading signal.",
      examples: [[{ user: "agent", content: { text: "Show me the free delayed market regime sample" } }]],
      validate: async () => true,
      handler: async (runtime) => getFreeRegimeSample(runtime)
    },
    {
      name: "GET_VELOX_BASIS_QUOTES",
      similes: ["GET_BASIS_QUOTES", "CHECK_STABLECOIN_BASIS", "GET_SPOT_QUOTES"],
      description: "Fetch live Binance/CoinDCX spot quotes and computed USDT/USDC basis for BTC, ETH and SOL. Costs $0.03 USDC on Base. Raw quotes, not trading signals.",
      examples: [[{ user: "agent", content: { text: "Get live USDT/USDC basis quotes" } }]],
      validate: async () => true,
      handler: async (runtime) => getBasisQuotes(runtime)
    }
  ]
};
var index_default = veloxAlphaPlugin;
export {
  BASE_CHAIN_ID,
  DEFAULT_HOST,
  MAX_AMOUNT_UNITS,
  index_default as default,
  getBasisQuotes,
  getFreeRegimeSample,
  veloxAlphaPlugin
};

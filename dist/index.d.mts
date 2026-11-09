/**
 * plugin-velox-alpha: live crypto spot quotes and a free delayed regime sample for ElizaOS agents.
 *
 * Actions:
 *  - GET_VELOX_FREE_REGIME_SAMPLE: one free, delayed (>= 60 s), reduced regime label per caller per hour.
 *  - GET_VELOX_BASIS_QUOTES: live Binance/CoinDCX spot quotes and computed USDT/USDC basis, $0.03 USDC per call on Base,
 *    paid with standard x402 v2 ("exact", EIP-3009). The payment is gasless for the payer.
 *
 * Honesty rules: when the service is unreachable or refuses, the action returns that status. It never returns invented
 * or cached market values. Raw quotes are not trading signals and carry no guarantee.
 */
declare const DEFAULT_HOST = "https://139-59-68-105.sslip.io";
declare const BASE_CHAIN_ID = 8453;
/** Never sign for more than the published price: 0.03 USDC has 6 decimals. */
declare const MAX_AMOUNT_UNITS = 30000n;
type VeloxResult = {
    status: "SUCCESS";
    data: unknown;
    settlement?: unknown;
} | {
    status: "PAYMENT_REQUIRED";
    price_units: string;
    asset: string;
    pay_to: string;
    network: string;
    instructions: string;
} | {
    status: "SERVICE_UNAVAILABLE" | "RATE_LIMITED" | "REJECTED" | "ERROR";
    http?: number;
    message: string;
};
/** One free delayed regime label per caller per hour. No payment, no key. */
declare function getFreeRegimeSample(runtime?: any): Promise<VeloxResult>;
/** Paid live quotes. Pays only when a payer key is configured and the amount is at most the published price. */
declare function getBasisQuotes(runtime?: any): Promise<VeloxResult>;
declare const veloxAlphaPlugin: {
    name: string;
    description: string;
    providers: unknown[];
    actions: {
        name: string;
        similes: string[];
        description: string;
        examples: {
            user: string;
            content: {
                text: string;
            };
        }[][];
        validate: () => Promise<boolean>;
        handler: (runtime: any) => Promise<VeloxResult>;
    }[];
};

export { BASE_CHAIN_ID, DEFAULT_HOST, MAX_AMOUNT_UNITS, type VeloxResult, veloxAlphaPlugin as default, getBasisQuotes, getFreeRegimeSample, veloxAlphaPlugin };

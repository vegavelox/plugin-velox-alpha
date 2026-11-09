#!/usr/bin/env python3
"""
arb_bot_listener.py — Reference Arbitrage Bot Listener for Velox x402 Basis Oracle.

Demonstrates how an autonomous cross-venue arbitrage bot polls live basis quotes
between Binance spot, CoinDCX spot, and Base DEX pools (Aerodrome/Uniswap v3)
paying $0.03 USDC on Base Mainnet via gasless x402 v2 (EIP-3009).

Usage:
    python arb_bot_listener.py --dry-run
    set VELOX_PAYER_KEY=0x...
    python arb_bot_listener.py --once
    python arb_bot_listener.py --interval 15 --hurdle 15.0
"""
from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
import time
from typing import Any, Dict, Optional

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("arb_bot_listener")

DEFAULT_HOST = os.getenv("VELOX_BASE_URL", "https://139-59-68-105.sslip.io").rstrip("/")
BASIS_PATH = "/api/v1/x402/basis"
MAX_PAY_UNITS = 30000  # 0.03 USDC (6 decimals)


class DataUnavailableError(Exception):
    """Raised when market data is offline or unreachable. No fallback to synthetic data."""


def parse_payment_required(resp: requests.Response) -> Dict[str, Any]:
    """
    Decodes payment requirements from HTTP response body or PAYMENT-REQUIRED header.
    Uses standard library json/base64 so external x402 library is not required for probing.
    """
    hdr = None
    for k, v in resp.headers.items():
        if k.lower() == "payment-required":
            hdr = v
            break

    if hdr:
        try:
            return json.loads(base64.b64decode(hdr).decode("utf-8"))
        except Exception:
            pass

    try:
        return resp.json()
    except Exception as exc:
        raise DataUnavailableError(f"Failed to parse payment terms from HTTP 402: {exc}") from exc


def fetch_basis_quotes(
    base_url: str = DEFAULT_HOST,
    payer_key: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    Queries the x402 basis endpoint. If challenged with HTTP 402, signs an EIP-3009
    authorization and retries with the PAYMENT-SIGNATURE header.
    """
    url = f"{base_url}{BASIS_PATH}"
    logger.info(f"Connecting to basis oracle: {url}")

    initial_resp = requests.get(url, timeout=12)
    if initial_resp.status_code == 200:
        return initial_resp.json()

    if initial_resp.status_code != 402:
        raise DataUnavailableError(
            f"Unexpected response from oracle: HTTP {initial_resp.status_code} - {initial_resp.text[:200]}"
        )

    req_data = parse_payment_required(initial_resp)
    accepts = req_data.get("accepts", [{}])
    if not accepts:
        raise DataUnavailableError("Oracle response missing accepts terms.")

    terms = accepts[0]
    amount_units = int(terms.get("amount", "0"))
    network = terms.get("network", "unknown")
    pay_to = terms.get("payTo", "unknown")
    scheme = terms.get("scheme", "exact")

    logger.info(
        f"x402 challenge verified: {amount_units} atomic units ({amount_units / 1e6:.2f} USDC) "
        f"on {network} to {pay_to} (scheme {scheme})"
    )

    if amount_units > MAX_PAY_UNITS:
        raise ValueError(f"Oracle terms ({amount_units}) exceed maximum authorized cap ({MAX_PAY_UNITS}).")

    if dry_run:
        logger.info("Dry-run active: payment challenge verified successfully; skipping live on-chain signing.")
        return {
            "status": "DRY_RUN_CHALLENGE_VERIFIED",
            "terms": {
                "amount": amount_units,
                "asset": terms.get("asset"),
                "network": network,
                "pay_to": pay_to,
                "scheme": scheme,
            },
        }

    key = payer_key or os.getenv("VELOX_PAYER_KEY")
    if not key:
        raise ValueError("Live query requires VELOX_PAYER_KEY environment variable holding a Base private key.")

    key = key if key.startswith("0x") else "0x" + key
    try:
        from eth_account import Account
        from x402 import x402ClientSync
        from x402.http.utils import decode_payment_required_header, decode_payment_response_header, encode_payment_signature_header
        from x402.mechanisms.evm.signers import EthAccountSigner
    except ImportError as err:
        raise ImportError(
            "Live signing requires the official x402 package. Install via: pip install \"x402[evm]\""
        ) from err

    required_obj = decode_payment_required_header(initial_resp.headers["PAYMENT-REQUIRED"])
    signer = EthAccountSigner(Account.from_key(key))
    client = x402ClientSync()
    try:
        from x402.mechanisms.evm.exact import register_exact_evm_client

        register_exact_evm_client(client, signer)
    except Exception:
        from x402.mechanisms.evm.exact.client import ExactEvmScheme

        client.register("eip155:*", ExactEvmScheme(signer=signer))

    payload = client.create_payment_payload(required_obj)
    headers = {"PAYMENT-SIGNATURE": encode_payment_signature_header(payload)}
    logger.info("Submitting gasless EIP-3009 payment authorization...")
    paid_resp = requests.get(url, headers=headers, timeout=60)

    if paid_resp.status_code != 200:
        raise DataUnavailableError(f"Settlement failed: HTTP {paid_resp.status_code} - {paid_resp.text[:300]}")

    for k, v in paid_resp.headers.items():
        if k.lower() == "payment-response":
            receipt = decode_payment_response_header(v)
            logger.info(f"Payment settled via facilitator! Tx: https://basescan.org/tx/{receipt.transaction}")
            break

    return paid_resp.json()


def evaluate_arbitrage_opportunities(quotes_payload: Dict[str, Any], hurdle_bps: float) -> int:
    """
    Evaluates cross-venue spreads against the hurdle rate.
    """
    opportunities_found = 0
    symbols = ["ETH", "BTC", "SOL"]

    for sym in symbols:
        data = quotes_payload.get(sym) or quotes_payload.get(f"{sym}/USDC") or {}
        if not data:
            continue

        cex_price = float(data.get("binance_mid") or data.get("cex_price") or 0.0)
        dex_price = float(data.get("base_pool_mid") or data.get("dex_price") or 0.0)

        if cex_price <= 0.0 or dex_price <= 0.0:
            continue

        spread_bps = abs(dex_price - cex_price) / cex_price * 10000.0
        divergence_side = "DEX_LOWER_THAN_CEX" if dex_price < cex_price else "CEX_LOWER_THAN_DEX"

        logger.info(
            f"[{sym}] CEX Mid: ${cex_price:,.2f} | DEX Mid: ${dex_price:,.2f} | "
            f"Divergence: {spread_bps:.2f} bps | Relative: {divergence_side}"
        )

        if spread_bps >= hurdle_bps:
            logger.warning(
                f"==> [THRESHOLD EXCEEDED] {sym} mid-price divergence {spread_bps:.2f} bps clears hurdle {hurdle_bps:.2f} bps. "
                f"Spread delta above hurdle: +{spread_bps - hurdle_bps:.2f} bps (raw quotes, not trade signals)."
            )
            opportunities_found += 1

    return opportunities_found


def main() -> int:
    parser = argparse.ArgumentParser(description="Velox x402 Arbitrage Bot Listener")
    parser.add_argument("--dry-run", action="store_true", help="Probe 402 challenge without signing/spending")
    parser.add_argument("--once", action="store_true", help="Run single poll and exit")
    parser.add_argument("--interval", type=int, default=15, help="Polling interval in seconds (default: 15)")
    parser.add_argument("--hurdle", type=float, default=15.0, help="Minimum spread hurdle in bps (default: 15.0)")
    parser.add_argument("--host", type=str, default=DEFAULT_HOST, help="Oracle host URL")
    args = parser.parse_args()

    logger.info("Starting Velox x402 Arbitrage Listener")
    logger.info(f"Target: {args.host} | Hurdle: {args.hurdle} bps | Poll Interval: {args.interval}s")

    if args.dry_run or args.once:
        data = fetch_basis_quotes(base_url=args.host, dry_run=args.dry_run)
        if args.dry_run:
            print(json.dumps(data, indent=2))
            return 0
        evaluate_arbitrage_opportunities(data, args.hurdle)
        return 0

    logger.info("Entering continuous polling loop (Ctrl+C to terminate)...")
    try:
        while True:
            try:
                data = fetch_basis_quotes(base_url=args.host, dry_run=False)
                evaluate_arbitrage_opportunities(data, args.hurdle)
            except Exception as e:
                logger.error(f"Polling cycle error: {e}")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        logger.info("Listener stopped by user.")

    return 0


if __name__ == "__main__":
    sys.exit(main())

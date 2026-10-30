#!/usr/bin/env python3
"""
dashboard.py — Cryptocurrency Analytics Dashboard backend.

A Flask web application that serves a professional dark-themed cryptocurrency
analytics dashboard powered by live Binance market data.

It reuses the existing binancedata.py module (fetch_24hr_tickers,
fetch_klines, resolve_base_url, BinanceDataError) without
modifying its public API. Public market data endpoints need no Binance API key.

Endpoints:
    GET /                         serve the dashboard HTML
    GET /api/health               health check
    GET /api/market-overview      BTC/ETH prices, 24h change, volume, stats
    GET /api/crypto-table         sortable/filterable cryptocurrency table
    GET /api/chart/<symbol>       historical kline data for a time window
    GET /api/gainers-losers       top gainers and top losers

Configuration (environment variables, see .env.example):
    BINANCE_MARKET    spot | futures        (default: futures)
    BINANCE_ENV       demo | live           (default: demo)
    BINANCE_QUOTE     quote asset           (default: USDT)
    DASHBOARD_HOST    bind host             (default: 127.0.0.1)
    DASHBOARD_PORT    bind port             (default: 5000)
    DASHBOARD_DEBUG   1 | 0                 (default: 0)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
import math
import threading
import time
from typing import Any

import pandas as pd
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

import binancedata
from binancedata import (
    BinanceDataError,
    fetch_24hr_tickers,
    fetch_klines,
    resolve_base_url,
)

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MARKET = os.environ.get("BINANCE_MARKET", "futures")
ENVIRONMENT = os.environ.get("BINANCE_ENV", "demo")
QUOTE = os.environ.get("BINANCE_QUOTE", "USDT").strip().upper()
DASHBOARD_HOST = os.environ.get("DASHBOARD_HOST", "127.0.0.1")
try:
    DASHBOARD_PORT = int(os.environ.get("DASHBOARD_PORT", "5000"))
except ValueError:
    DASHBOARD_PORT = 5000
DASHBOARD_DEBUG = os.environ.get("DASHBOARD_DEBUG", "0").lower() in ("1", "true", "yes")

MIN_VOLUME = float(os.environ.get("DASHBOARD_MIN_VOLUME", "1000000"))
TABLE_LIMIT = int(os.environ.get("DASHBOARD_TABLE_LIMIT", "100"))
TICKER_CACHE_TTL_SECONDS = 10

app = Flask(__name__, template_folder="templates", static_folder="static")

# A single reused session for connection pooling.
SESSION = binancedata.requests.Session()

# Cache the resolved base URL so we do not re-resolve on every request.
BASE_URL = resolve_base_url(MARKET, ENVIRONMENT, None)
_ticker_cache_lock = threading.Lock()
_ticker_cache: pd.DataFrame | None = None
_ticker_cache_time = 0.0


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        number = float(value)
        return number if math.isfinite(number) else default
    except (OverflowError, TypeError, ValueError):
        return default


def _query_int(value: str | None, default: int, name: str) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer.") from exc


def _fetch_market_tickers() -> pd.DataFrame:
    global _ticker_cache, _ticker_cache_time
    with _ticker_cache_lock:
        now = time.monotonic()
        if _ticker_cache is None or now - _ticker_cache_time >= TICKER_CACHE_TTL_SECONDS:
            df = fetch_24hr_tickers(BASE_URL, MARKET, SESSION)
            if "symbol" not in df.columns:
                raise BinanceDataError("Binance ticker response is missing symbols.")
            df = df[df["symbol"].str.endswith(QUOTE, na=False)].copy()
            if df.empty:
                raise BinanceDataError(f"No market pairs found for quote asset {QUOTE}.")
            _ticker_cache = df
            _ticker_cache_time = time.monotonic()
        return _ticker_cache.copy()


def _error_response(message: str, status_code: int = 500):
    return jsonify({"error": message, "ok": False}), status_code


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    """Serve the dashboard page."""
    return render_template(
        "dashboard.html",
        quote=QUOTE,
        min_volume=MIN_VOLUME,
        table_limit=TABLE_LIMIT,
    )


@app.route("/api/health")
def health():
    """Health check endpoint. Verifies the Binance API is reachable."""
    try:
        df = _fetch_market_tickers()
        return jsonify(
            {
                "ok": True,
                "market": MARKET,
                "environment": ENVIRONMENT,
                "base_url": BASE_URL,
                "symbols": int(len(df)),
                "timestamp": _utc_now_iso(),
            }
        )
    except BinanceDataError as exc:
        return _error_response(f"Binance unreachable: {exc}", 503)


@app.route("/api/market-overview")
def market_overview():
    """Return BTC and ETH overview metrics plus general market statistics."""
    try:
        df = _fetch_market_tickers()
    except BinanceDataError as exc:
        return _error_response(f"Failed to load market data: {exc}", 503)

    def find(symbol: str) -> dict[str, Any] | None:
        match = df[df["symbol"] == symbol]
        if match.empty:
            return None
        row = match.iloc[0]
        return {
            "symbol": row["symbol"],
            "price": _safe_float(row.get("lastPrice")),
            "change_percent": _safe_float(row.get("priceChangePercent")),
            "change": _safe_float(row.get("priceChange")),
            "volume": _safe_float(row.get("quoteVolume")),
            "high": _safe_float(row.get("highPrice")),
            "low": _safe_float(row.get("lowPrice")),
        }

    btc_symbol = f"BTC{QUOTE}"
    eth_symbol = f"ETH{QUOTE}"
    btc = find(btc_symbol) or {"symbol": btc_symbol, "price": 0, "change_percent": 0, "change": 0, "volume": 0, "high": 0, "low": 0}
    eth = find(eth_symbol) or {"symbol": eth_symbol, "price": 0, "change_percent": 0, "change": 0, "volume": 0, "high": 0, "low": 0}

    total_volume = float(df["quoteVolume"].sum()) if "quoteVolume" in df.columns else 0.0
    avg_change = float(df["priceChangePercent"].mean()) if "priceChangePercent" in df.columns else 0.0
    gainers = int((df["priceChangePercent"] > 0).sum()) if "priceChangePercent" in df.columns else 0
    losers = int((df["priceChangePercent"] < 0).sum()) if "priceChangePercent" in df.columns else 0

    return jsonify(
        {
            "ok": True,
            "timestamp": _utc_now_iso(),
            "market": f"{MARKET}/{ENVIRONMENT}",
            "bitcoin": btc,
            "ethereum": eth,
            "market_stats": {
                "total_pairs": int(len(df)),
                "total_24h_volume": total_volume,
                "average_change_percent": avg_change,
                "gainers_24h": gainers,
                "losers_24h": losers,
            },
        }
    )


@app.route("/api/crypto-table")
def crypto_table():
    """Return the cryptocurrency table with optional search, sort, and filter.

    Query params:
        q         search substring (symbol or name)
        sort      column to sort by (price, change_percent, volume, symbol)
        order     asc | desc
        min_volume  minimum 24h quote volume filter
        limit     max rows to return
    """
    search = request.args.get("q", "").strip().upper()
    sort_col = request.args.get("sort", "quoteVolume").strip()
    order = request.args.get("order", "desc").strip().lower()
    try:
        min_volume = float(request.args.get("min_volume", MIN_VOLUME))
        limit = _query_int(request.args.get("limit"), TABLE_LIMIT, "limit")
    except ValueError as exc:
        return _error_response(str(exc), 400)
    if not math.isfinite(min_volume) or min_volume < 0:
        return _error_response("min_volume must be a finite non-negative number.", 400)

    try:
        df = _fetch_market_tickers()
    except BinanceDataError as exc:
        return _error_response(f"Failed to load market data: {exc}", 503)

    # Filter by min volume.
    if "quoteVolume" in df.columns:
        df = df[df["quoteVolume"] >= min_volume]

    # Search filter on symbol.
    if search:
        df = df[df["symbol"].str.contains(search, na=False, regex=False)]

    # Normalise sort column.
    column_map = {
        "price": "lastPrice",
        "change_percent": "priceChangePercent",
        "change": "priceChange",
        "volume": "quoteVolume",
        "symbol": "symbol",
        "high": "highPrice",
        "low": "lowPrice",
    }
    sort_key = column_map.get(sort_col, "quoteVolume")
    if sort_key not in df.columns:
        sort_key = "quoteVolume"

    ascending = order == "asc"
    df = df.sort_values(sort_key, ascending=ascending, na_position="last")

    limit = max(1, min(limit, 500))
    df = df.head(limit)

    rows = []
    for _, row in df.iterrows():
        rows.append(
            {
                "symbol": row.get("symbol", ""),
                "name": row.get("symbol", ""),  # Binance symbols are like BTCUSDT
                "price": _safe_float(row.get("lastPrice")),
                "change_percent": _safe_float(row.get("priceChangePercent")),
                "change": _safe_float(row.get("priceChange")),
                "volume": _safe_float(row.get("quoteVolume")),
                "high": _safe_float(row.get("highPrice")),
                "low": _safe_float(row.get("lowPrice")),
            }
        )

    return jsonify(
        {
            "ok": True,
            "count": len(rows),
            "timestamp": _utc_now_iso(),
            "rows": rows,
        }
    )


@app.route("/api/chart/<symbol>")
def chart(symbol: str):
    """Return historical kline data for a symbol and time window.

    Query params:
        window  1H | 24H | 7D | 30D | 1Y  (default: 24H)
    """
    symbol = symbol.strip().upper()
    if not symbol:
        return _error_response("Symbol is required", 400)

    window = request.args.get("window", "24H").strip().upper()
    from binancedata import KLINE_WINDOW_INTERVAL

    if window not in KLINE_WINDOW_INTERVAL:
        return _error_response(
            f"Invalid window '{window}'. Use one of: {', '.join(KLINE_WINDOW_INTERVAL)}",
            400,
        )

    interval, limit = KLINE_WINDOW_INTERVAL[window]

    try:
        rows = fetch_klines(BASE_URL, MARKET, symbol, interval=interval, limit=limit, session=SESSION)
    except BinanceDataError as exc:
        return _error_response(f"Failed to load chart data: {exc}", 503)

    points = [
        {
            "t": row["open_time"],
            "o": row["open"],
            "h": row["high"],
            "l": row["low"],
            "c": row["close"],
            "v": row["volume"],
        }
        for row in rows
    ]

    return jsonify(
        {
            "ok": True,
            "symbol": symbol,
            "market": f"{MARKET}/{ENVIRONMENT}",
            "interval": interval,
            "window": window,
            "points": points,
            "count": len(points),
            "timestamp": _utc_now_iso(),
        }
    )


@app.route("/api/gainers-losers")
def gainers_losers():
    """Return top gainers and top losers based on 24h price change percent."""
    try:
        top = _query_int(request.args.get("top"), 10, "top")
        gainers_top = _query_int(
            request.args.get("gainers_top"), top, "gainers_top"
        )
        losers_top = _query_int(request.args.get("losers_top"), top, "losers_top")
    except ValueError as exc:
        return _error_response(str(exc), 400)
    gainers_top = max(1, min(gainers_top, 50))
    losers_top = max(1, min(losers_top, 50))

    try:
        df = _fetch_market_tickers()
    except BinanceDataError as exc:
        return _error_response(f"Failed to load market data: {exc}", 503)

    if "priceChangePercent" not in df.columns:
        return _error_response("Price change data unavailable", 503)

    liquid = df.dropna(subset=["priceChangePercent"]).copy()
    if "quoteVolume" in liquid.columns:
        liquid = liquid[liquid["quoteVolume"] >= MIN_VOLUME]

    gainers = (
        liquid[liquid["priceChangePercent"] > 0]
        .sort_values("priceChangePercent", ascending=False)
        .head(gainers_top)
        .to_dict(orient="records")
    )
    losers = (
        liquid[liquid["priceChangePercent"] < 0]
        .sort_values("priceChangePercent", ascending=True)
        .head(losers_top)
        .to_dict(orient="records")
    )

    def clean_row(row):
        return {
            "symbol": row.get("symbol", ""),
            "price": _safe_float(row.get("lastPrice")),
            "change_percent": _safe_float(row.get("priceChangePercent")),
            "change": _safe_float(row.get("priceChange")),
            "volume": _safe_float(row.get("quoteVolume")),
        }

    return jsonify(
        {
            "ok": True,
            "top": top,
            "gainers_top": gainers_top,
            "losers_top": losers_top,
            "timestamp": _utc_now_iso(),
            "gainers": [clean_row(r) for r in gainers],
            "losers": [clean_row(r) for r in losers],
        }
    )


# ---------------------------------------------------------------------------
# Application factory entry point
# ---------------------------------------------------------------------------
def create_app() -> Flask:
    return app


if __name__ == "__main__":
    print(f"Starting dashboard on http://{DASHBOARD_HOST}:{DASHBOARD_PORT}")
    print(f"Binance market: {MARKET}/{ENVIRONMENT} -> {BASE_URL}")
    app.run(host=DASHBOARD_HOST, port=DASHBOARD_PORT, debug=DASHBOARD_DEBUG)

import unittest
from unittest.mock import patch

import pandas as pd

import dashboard


class DashboardRoutesTest(unittest.TestCase):
    def setUp(self):
        dashboard.app.config["TESTING"] = True
        dashboard._ticker_cache = None
        dashboard._ticker_cache_time = 0.0
        self.client = dashboard.app.test_client()
        self.tickers = pd.DataFrame(
            [
                {
                    "symbol": "BTCUSDT",
                    "lastPrice": 10.0,
                    "priceChangePercent": 4.0,
                    "priceChange": 0.4,
                    "quoteVolume": 2_000_000.0,
                    "highPrice": 11.0,
                    "lowPrice": 9.0,
                },
                {
                    "symbol": "ETHUSDT",
                    "lastPrice": 5.0,
                    "priceChangePercent": -3.0,
                    "priceChange": -0.2,
                    "quoteVolume": 1_500_000.0,
                    "highPrice": 6.0,
                    "lowPrice": 4.0,
                },
                {
                    "symbol": "SOLUSDT",
                    "lastPrice": 2.0,
                    "priceChangePercent": 1.0,
                    "priceChange": 0.1,
                    "quoteVolume": 2_500_000.0,
                    "highPrice": 3.0,
                    "lowPrice": 1.0,
                },
                {
                    "symbol": "BTCEUR",
                    "lastPrice": 8.0,
                    "priceChangePercent": 99.0,
                    "priceChange": 1.0,
                    "quoteVolume": 5_000_000.0,
                    "highPrice": 9.0,
                    "lowPrice": 7.0,
                },
            ]
        )

    def test_dashboard_uses_configured_quote_and_limits(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('data-quote="USDT"', html)
        self.assertIn('value="BTCUSDT"', html)
        self.assertIn('<option value="100" selected>100</option>', html)

    @patch.object(dashboard, "fetch_24hr_tickers")
    def test_market_data_is_cached_and_filtered_by_quote(self, fetch_tickers):
        fetch_tickers.return_value = self.tickers

        overview = self.client.get("/api/market-overview")
        table = self.client.get("/api/crypto-table?min_volume=0")

        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.json["market_stats"]["total_pairs"], 3)
        self.assertEqual(overview.json["bitcoin"]["price"], 10.0)
        self.assertTrue(all(row["symbol"].endswith("USDT") for row in table.json["rows"]))
        fetch_tickers.assert_called_once()

    @patch.object(dashboard, "fetch_24hr_tickers")
    def test_search_is_literal_and_bad_filters_return_400(self, fetch_tickers):
        fetch_tickers.return_value = self.tickers

        search = self.client.get("/api/crypto-table?q=.&min_volume=0")
        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json["rows"], [])
        self.assertEqual(self.client.get("/api/crypto-table?limit=invalid").status_code, 400)
        self.assertEqual(self.client.get("/api/crypto-table?min_volume=NaN").status_code, 400)

    @patch.object(dashboard, "fetch_24hr_tickers")
    def test_gainers_and_losers_have_independent_limits(self, fetch_tickers):
        fetch_tickers.return_value = self.tickers

        response = self.client.get(
            "/api/gainers-losers?gainers_top=1&losers_top=2"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json["gainers"]), 1)
        self.assertEqual(len(response.json["losers"]), 1)
        self.assertLess(response.json["losers"][0]["change_percent"], 0)

    @patch.object(dashboard, "fetch_klines")
    def test_chart_returns_selected_window(self, fetch_klines):
        fetch_klines.return_value = [
            {
                "open_time": 1,
                "open": 10.0,
                "high": 12.0,
                "low": 9.0,
                "close": 11.0,
                "volume": 5.0,
            }
        ]

        response = self.client.get("/api/chart/BTCUSDT?window=1H")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["interval"], "1m")
        self.assertEqual(response.json["points"][0]["c"], 11.0)
        self.assertEqual(self.client.get("/api/chart/BTCUSDT?window=bad").status_code, 400)


if __name__ == "__main__":
    unittest.main()

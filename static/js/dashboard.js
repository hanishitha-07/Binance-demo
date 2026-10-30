/**
 * CryptoPulse Dashboard — Frontend JavaScript
 *
 * Communicates with the Flask backend at /api/* endpoints. No API keys or
 * secrets are ever stored or transmitted from the frontend. All Binance data
 * is fetched server-side via binancedata.py.
 */

const API_BASE = ""; // same-origin Flask routes
const POLL_INTERVAL_MS = 30000; // refresh overview & table every 30s
const QUOTE = document.body.dataset.quote || "USDT";
const DOLLAR_QUOTES = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD"]);

// Chart.js instance holder
let priceChart = null;
let chartRequestId = 0;
let refreshPromise = null;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatCurrency(value, decimals = 4) {
    if (!Number.isFinite(value) || value === 0) return "-";
    const formatted = Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: decimals });
    const dollarQuote = DOLLAR_QUOTES.has(QUOTE);
    const prefix = dollarQuote ? "$" : "";
    const unit = dollarQuote ? "" : ` ${QUOTE}`;
    return `${value < 0 ? "-" : ""}${prefix}${formatted}${unit}`;
}

function formatCompact(value) {
    if (!Number.isFinite(value)) return "-";
    const abs = Math.abs(value);
    let scaled = abs;
    let suffix = "";
    if (abs >= 1e9) { scaled = abs / 1e9; suffix = "B"; }
    else if (abs >= 1e6) { scaled = abs / 1e6; suffix = "M"; }
    else if (abs >= 1e3) { scaled = abs / 1e3; suffix = "K"; }
    const formatted = `${scaled.toFixed(2)}${suffix}`;
    return DOLLAR_QUOTES.has(QUOTE) ? `$${formatted}` : `${formatted} ${QUOTE}`;
}

function formatPercent(value, showSign = true) {
    if (!Number.isFinite(value)) return "-";
    const sign = value >= 0 && showSign ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
}

function formatTime(ms, windowKey) {
    const d = new Date(ms);
    if (["7D", "30D", "1Y"].includes(windowKey)) {
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setClass(id, className) {
    const el = document.getElementById(id);
    if (el) el.className = className;
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------
function showErrorBanner(message) {
    const banner = document.getElementById("errorBanner");
    const msgEl = document.getElementById("errorMessage");
    if (banner && msgEl) {
        msgEl.textContent = message;
        banner.classList.remove("hidden");
    }
}

function hideErrorBanner() {
    const banner = document.getElementById("errorBanner");
    if (banner) banner.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// API fetch wrapper
// ---------------------------------------------------------------------------
async function fetchJson(path) {
    const response = await fetch(`${API_BASE}${path}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    }
    return response.json();
}

// ---------------------------------------------------------------------------
// Market Overview
// ---------------------------------------------------------------------------
async function loadMarketOverview() {
    try {
        const data = await fetchJson("/api/market-overview");
        if (!data.ok) throw new Error(data.error || "Failed to load overview");

        const btc = data.bitcoin || {};
        const eth = data.ethereum || {};
        const stats = data.market_stats || {};

        setText("statBtcPrice", formatCurrency(btc.price, 2));
        setClass("statBtcChange", btc.change_percent >= 0 ? "stat-delta positive" : "stat-delta negative");
        setText("statBtcChange", formatPercent(btc.change_percent));
        setText("statBtcVolume", formatCompact(btc.volume));
        setText("statBtcHigh", formatCurrency(btc.high, 2));
        setText("statBtcLow", formatCurrency(btc.low, 2));

        setText("statEthPrice", formatCurrency(eth.price, 2));
        setClass("statEthChange", eth.change_percent >= 0 ? "stat-delta positive" : "stat-delta negative");
        setText("statEthChange", formatPercent(eth.change_percent));
        setText("statEthVolume", formatCompact(eth.volume));
        setText("statEthHigh", formatCurrency(eth.high, 2));
        setText("statEthLow", formatCurrency(eth.low, 2));

        setText("statPairs", stats.total_pairs ? stats.total_pairs.toLocaleString() : "-");
        setText("statVolume", formatCompact(stats.total_24h_volume));
        setText("statSentiment", stats.average_change_percent >= 0 ? "Bullish" : "Bearish");
        setClass("statSentimentDelta", stats.average_change_percent >= 0 ? "stat-delta positive" : "stat-delta negative");
        setText("statSentimentDelta", formatPercent(stats.average_change_percent));

        setText("serverTime", data.timestamp || "-");

        const envEl = document.getElementById("footerEnv");
        if (envEl) envEl.textContent = `${data.market || ""}`;

        return true;
    } catch (err) {
        console.error("market overview error:", err);
        showErrorBanner("Unable to load market overview from Binance API.");
        return false;
    }
}

// ---------------------------------------------------------------------------
// Crypto Table
// ---------------------------------------------------------------------------
let tableState = {
    sort: "quoteVolume",
    order: "desc",
    search: "",
    minVolume: Number(document.body.dataset.minVolume) || 1000000,
    limit: Number(document.body.dataset.tableLimit) || 50,
};

function buildTableUrl() {
    const params = new URLSearchParams();
    if (tableState.sort) params.set("sort", tableState.sort);
    if (tableState.order) params.set("order", tableState.order);
    if (tableState.search) params.set("q", tableState.search);
    params.set("min_volume", tableState.minVolume);
    params.set("limit", tableState.limit);
    return `/api/crypto-table?${params.toString()}`;
}

function renderTable(rows) {
    const tbody = document.getElementById("cryptoTableBody");
    const empty = document.getElementById("tableEmpty");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!rows || rows.length === 0) {
        if (empty) empty.classList.remove("hidden");
        return;
    }
    if (empty) empty.classList.add("hidden");

    for (const row of rows) {
        const changeClass = row.change_percent >= 0 ? "positive" : row.change_percent < 0 ? "negative" : "neutral-text";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="symbol-cell"><button class="chart-pair-button" type="button" title="Show ${escapeHtml(row.symbol)} chart">${escapeHtml(row.symbol)}</button></td>
            <td class="price-cell">${formatCurrency(row.price, row.price < 1 ? 6 : 4)}</td>
            <td class="change-cell ${changeClass}">${formatPercent(row.change_percent)}</td>
            <td class="volume-cell">${formatCompact(row.volume)}</td>
            <td class="high-cell">${formatCurrency(row.high, row.high < 1 ? 6 : 4)}</td>
            <td class="low-cell">${formatCurrency(row.low, row.low < 1 ? 6 : 4)}</td>
        `;
        tbody.appendChild(tr);
    }
}

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

async function loadCryptoTable() {
    try {
        const data = await fetchJson(buildTableUrl());
        if (!data.ok) throw new Error(data.error || "Failed to load table");
        renderTable(data.rows || []);
        return true;
    } catch (err) {
        console.error("crypto table error:", err);
        const tbody = document.getElementById("cryptoTableBody");
        if (tbody) tbody.innerHTML = `<tr class="loading-row"><td colspan="6">Error loading table data.</td></tr>`;
        showErrorBanner("Unable to load cryptocurrency table.");
        return false;
    }
}

// ---------------------------------------------------------------------------
// Charts (Chart.js)
// ---------------------------------------------------------------------------
async function loadChart(symbol, windowKey) {
    const requestId = ++chartRequestId;
    const chartEl = document.getElementById("priceChart");
    const loadingEl = document.getElementById("chartLoading");
    const emptyEl = document.getElementById("chartEmpty");
    const canvas = chartEl;

    if (loadingEl) loadingEl.style.display = "flex";
    if (emptyEl) emptyEl.style.display = "none";

    try {
        const data = await fetchJson(`/api/chart/${encodeURIComponent(symbol)}?window=${encodeURIComponent(windowKey)}`);
        if (requestId !== chartRequestId) return;
        if (!data.ok) throw new Error(data.error || "Failed to load chart");

        const points = data.points || [];
        if (points.length === 0) {
            if (priceChart) {
                priceChart.destroy();
                priceChart = null;
            }
            if (canvas) canvas.style.display = "none";
            if (emptyEl) emptyEl.style.display = "flex";
            if (loadingEl) loadingEl.style.display = "none";
            setChartSummary(symbol, windowKey, []);
            return true;
        }

        if (canvas) canvas.style.display = "block";

        const labels = points.map((p) => formatTime(p.t, windowKey));
        const closes = points.map((p) => p.c);
        setChartSummary(symbol, windowKey, points);

        if (!canvas) throw new Error("Price chart canvas is missing.");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Unable to initialize the price chart.");

        // Destroy existing chart instance
        if (priceChart) {
            priceChart.destroy();
            priceChart = null;
        }

        const change = points[0].c === 0 ? 0 : (points[points.length - 1].c / points[0].c - 1) * 100;
        const isPositive = change >= 0;
        const lineColor = isPositive ? "#34d399" : "#f87171";
        const gradient = ctx.createLinearGradient(0, 0, 0, 340);
        gradient.addColorStop(0, isPositive ? "rgba(52, 211, 153, 0.28)" : "rgba(248, 113, 113, 0.28)");
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

        priceChart = new Chart(ctx, {
            type: "line",
            data: {
                labels: labels,
                datasets: [{
                    label: symbol,
                    data: closes,
                    borderColor: lineColor,
                    backgroundColor: gradient,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    fill: true,
                    tension: 0.35,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: "nearest",
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "rgba(10, 15, 26, 0.9)",
                        titleColor: "#e8eef7",
                        bodyColor: "#cbd5e1",
                        borderColor: "rgba(168, 85, 247, 0.4)",
                        borderWidth: 1,
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            label: (ctx) => formatCurrency(ctx.parsed.y, ctx.parsed.y < 1 ? 8 : 4),
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: "rgba(255, 255, 255, 0.03)", drawBorder: false },
                        ticks: { color: "#64748b", font: { size: 11 }, maxRotation: 0 },
                    },
                    y: {
                        grid: { color: "rgba(255, 255, 255, 0.03)", drawBorder: false },
                        ticks: {
                            color: "#94a3b8",
                            font: { size: 11 },
                            callback: (v) => formatCurrency(v, Math.abs(v) < 1 ? 8 : 2),
                        },
                    },
                },
                animation: {
                    duration: 700,
                    easing: "easeOutQuart",
                },
            },
        });

        if (loadingEl) loadingEl.style.display = "none";
        if (emptyEl) emptyEl.style.display = "none";
        return true;
    } catch (err) {
        if (requestId !== chartRequestId) return;
        console.error("chart error:", err);
        if (priceChart) {
            priceChart.destroy();
            priceChart = null;
        }
        if (canvas) canvas.style.display = "none";
        if (loadingEl) loadingEl.style.display = "none";
        if (emptyEl) emptyEl.style.display = "flex";
        showErrorBanner("Unable to load chart data from Binance API.");
        return false;
    }
}

function setChartSummary(symbol, windowKey, points) {
    setText("chartPairLabel", symbol);
    setText("chartWindowCaption", `${windowKey} change`);
    if (!points.length) {
        setText("chartLastPrice", "-");
        setText("chartWindowChange", "-");
        setText("chartHigh", "-");
        setText("chartLow", "-");
        setClass("chartWindowChange", "neutral-text");
        return;
    }

    const closes = points.map((point) => point.c);
    const current = closes[closes.length - 1];
    const first = closes[0];
    const change = first === 0 ? 0 : (current / first - 1) * 100;
    const high = Math.max(...points.map((point) => point.h));
    const low = Math.min(...points.map((point) => point.l));

    setText("chartLastPrice", formatCurrency(current, current < 1 ? 8 : 4));
    setText("chartWindowChange", formatPercent(change));
    setClass("chartWindowChange", change >= 0 ? "positive" : "negative");
    setText("chartHigh", formatCurrency(high, high < 1 ? 8 : 4));
    setText("chartLow", formatCurrency(low, low < 1 ? 8 : 4));
}

// ---------------------------------------------------------------------------
// Gainers / Losers
// ---------------------------------------------------------------------------
async function loadGainersLosers() {
    try {
        const gainersTop = document.getElementById("gainersTop")?.value || "10";
        const losersTop = document.getElementById("losersTop")?.value || "10";
        const params = new URLSearchParams({ gainers_top: gainersTop, losers_top: losersTop });
        const data = await fetchJson(`/api/gainers-losers?${params.toString()}`);
        if (!data.ok) throw new Error(data.error || "Failed to load analytics");

        renderList("gainersTableBody", data.gainers || []);
        renderList("losersTableBody", data.losers || []);
        return true;
    } catch (err) {
        console.error("gainers/losers error:", err);
        showErrorBanner("Unable to load market analytics.");
        return false;
    }
}

function renderList(tbodyId, items) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!items || items.length === 0) {
        tbody.innerHTML = `<tr class="loading-row"><td colspan="4">No data available.</td></tr>`;
        return;
    }

    for (const row of items) {
        const changeClass = row.change_percent >= 0 ? "positive" : "negative";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="symbol-cell">${escapeHtml(row.symbol)}</td>
            <td class="price-cell">${formatCurrency(row.price, row.price < 1 ? 6 : 4)}</td>
            <td class="change-cell ${changeClass}">${formatPercent(row.change_percent)}</td>
            <td class="volume-cell">${formatCompact(row.volume)}</td>
        `;
        tbody.appendChild(tr);
    }
}

async function loadHealth() {
    try {
        const data = await fetchJson("/api/health");
        const marketEl = document.getElementById("marketEnv");
        const market = data.market ? data.market.charAt(0).toUpperCase() + data.market.slice(1) : "";
        const environment = data.environment ? data.environment.charAt(0).toUpperCase() + data.environment.slice(1) : "";
        if (marketEl) marketEl.textContent = `${market} / ${environment}`;
        const liveText = document.getElementById("liveText");
        const liveIndicator = document.getElementById("liveIndicator");
        if (liveText) liveText.textContent = data.environment === "live" ? "LIVE" : "DEMO";
        if (liveIndicator) {
            liveIndicator.classList.toggle("demo", data.environment !== "live");
            liveIndicator.classList.remove("offline");
        }
        return true;
    } catch (err) {
        console.warn("health check failed:", err);
        const liveText = document.getElementById("liveText");
        const liveIndicator = document.getElementById("liveIndicator");
        if (liveText) liveText.textContent = "OFFLINE";
        if (liveIndicator) {
            liveIndicator.classList.add("offline");
            liveIndicator.classList.remove("demo");
        }
        showErrorBanner("Binance API is currently unreachable.");
        return false;
    }
}

async function refreshDashboard() {
    if (refreshPromise) return refreshPromise;

    const button = document.getElementById("refreshButton");
    const label = document.getElementById("refreshText");
    if (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
    }
    if (label) label.textContent = "Refreshing";

    refreshPromise = (async () => {
        const chartSymbol = document.getElementById("chartSymbol");
        const activeWindow = document.querySelector(".time-btn.active");
        const windowKey = activeWindow ? activeWindow.dataset.window : "1H";
        const results = await Promise.all([
            loadHealth(),
            loadMarketOverview(),
            loadCryptoTable(),
            loadChart(chartSymbol ? chartSymbol.value : `BTC${QUOTE}`, windowKey),
            loadGainersLosers(),
        ]);
        if (results.every(Boolean)) {
            hideErrorBanner();
            if (label) label.textContent = "Updated";
            window.setTimeout(() => {
                if (label && label.textContent === "Updated") label.textContent = "Refresh";
            }, 1800);
        } else if (label) {
            label.textContent = "Retry";
        }
        return results.every(Boolean);
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
        if (button) {
            button.disabled = false;
            button.removeAttribute("aria-busy");
        }
    }
}

// ---------------------------------------------------------------------------
// Initialization & Event Listeners
// ---------------------------------------------------------------------------
function init() {
    refreshDashboard();

    // Polling
    setInterval(() => {
        refreshDashboard();
    }, POLL_INTERVAL_MS);

    const refreshButton = document.getElementById("refreshButton");
    if (refreshButton) refreshButton.addEventListener("click", refreshDashboard);

    const chartSymbol = document.getElementById("chartSymbol");
    // Table controls
    const searchInput = document.getElementById("tableSearch");
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener("input", (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                tableState.search = e.target.value.trim();
                loadCryptoTable();
            }, 300);
        });
    }

    const volumeFilter = document.getElementById("filterVolume");
    if (volumeFilter) {
        volumeFilter.addEventListener("change", (e) => {
            tableState.minVolume = parseFloat(e.target.value) || 1000000;
            loadCryptoTable();
        });
    }

    const limitSelect = document.getElementById("tableLimit");
    if (limitSelect) {
        limitSelect.addEventListener("change", (e) => {
            tableState.limit = parseInt(e.target.value, 10) || 50;
            loadCryptoTable();
        });
    }

    // Table sorting
    document.querySelectorAll("thead th[data-sort]").forEach((th) => {
        th.addEventListener("click", () => {
            const column = th.getAttribute("data-sort");
            if (tableState.sort === column) {
                tableState.order = tableState.order === "asc" ? "desc" : "asc";
            } else {
                tableState.sort = column;
                tableState.order = "desc";
            }
            // Update active sort visual
            document.querySelectorAll("thead th[data-sort]").forEach((h) => {
                const icon = h.querySelector(".sort-icon");
                if (icon) icon.style.opacity = "0.4";
                h.style.color = "";
            });
            const activeIcon = th.querySelector(".sort-icon");
            if (activeIcon) activeIcon.style.opacity = "1";
            th.style.color = tableState.order === "desc" ? "#a855f7" : "#38bdf8";
            loadCryptoTable();
        });
    });

    // Chart controls
    if (chartSymbol) {
        chartSymbol.addEventListener("change", (e) => {
            const windowBtn = document.querySelector(".time-btn.active");
            const windowKey = windowBtn ? windowBtn.getAttribute("data-window") : "24H";
            loadChart(e.target.value, windowKey);
        });
    }

    document.querySelectorAll(".time-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".time-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const symbol = chartSymbol ? chartSymbol.value : "BTCUSDT";
            loadChart(symbol, btn.getAttribute("data-window"));
        });
    });

    // Gainers/losers selectors
    const gainersTop = document.getElementById("gainersTop");
    const losersTop = document.getElementById("losersTop");
    if (gainersTop) {
        gainersTop.addEventListener("change", loadGainersLosers);
    }
    if (losersTop) {
        losersTop.addEventListener("change", loadGainersLosers);
    }

    const tableBody = document.getElementById("cryptoTableBody");
    if (tableBody) {
        tableBody.addEventListener("click", (event) => {
            const button = event.target.closest(".chart-pair-button");
            if (!button) return;

            const symbol = button.textContent.trim();
            if (chartSymbol && !Array.from(chartSymbol.options).some((option) => option.value === symbol)) {
                chartSymbol.add(new Option(symbol, symbol));
            }
            if (chartSymbol) chartSymbol.value = symbol;
            const windowBtn = document.querySelector(".time-btn.active");
            loadChart(symbol, windowBtn ? windowBtn.dataset.window : "1H");
            document.getElementById("priceChart")?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
    }
}

// Start when DOM is ready
document.addEventListener("DOMContentLoaded", init);

/**
 * AssetFlow Core Engine - v2.0
 * 系統優化：模組化架構、數據快取與視覺強化
 */

// --- 核心配置 ---
let assets = JSON.parse(localStorage.getItem('assets')) || [];
let usdToTwdRate = 32.5;
let assetChart = null;

const CATEGORY_MAP = {
    'TW': { title: '台股資產', icon: '📈', color: '#3b82f6', currency: 'TWD' },
    'US': { title: '美股資產', icon: '🇺🇸', color: '#a78bfa', currency: 'USD' },
    'METAL': { title: '貴金屬', icon: '💎', color: '#fbbf24', currency: 'USD' },
    'CRYPTO': { title: '加密貨幣', icon: '₿', color: '#10b981', currency: 'USD' }
};

// --- 初始化程序 ---
document.addEventListener('DOMContentLoaded', async () => {
    UIManager.render();
    await PriceService.updateAll();

    // 每 2 分鐘自動同步一次
    setInterval(() => PriceService.updateAll(), 120 * 1000);
});

// --- 事件處理 ---
document.getElementById('add-asset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbolInput = document.getElementById('symbol');
    const sharesInput = document.getElementById('shares');

    const symbol = symbolInput.value.toUpperCase().trim();
    const shares = parseFloat(sharesInput.value);

    if (!symbol || isNaN(shares)) return;

    const newAsset = {
        id: Date.now(),
        symbol,
        shares,
        price: 0,
        currency: 'USD',
        name: '讀取中...',
        history: [], // 儲存 24H 趨勢
        lastUpdated: null
    };

    assets.push(newAsset);
    saveAssets();
    UIManager.render();

    symbolInput.value = '';
    sharesInput.value = '';

    await PriceService.fetchSingle(newAsset.id);
});

function saveAssets() {
    localStorage.setItem('assets', JSON.stringify(assets));
}

// --- 價格服務模組 (Service Layer) ---
const PriceService = {
    async updateAll() {
        const refreshIcon = document.getElementById('refresh-icon');
        refreshIcon.classList.add('syncing');

        try {
            // 先抓匯率
            const fxUrl = `https://query1.finance.yahoo.com/v8/finance/chart/TWD=X?interval=1m&range=1d`;
            const fxData = await this.fetchWithProxy(fxUrl);
            if (fxData?.chart?.result) {
                usdToTwdRate = fxData.chart.result[0].meta.regularMarketPrice;
            }
        } catch (e) { console.warn("匯率更新失敗", e); }

        // 分批併發請求，避免 Proxy 封鎖
        const batchSize = 3;
        for (let i = 0; i < assets.length; i += batchSize) {
            const batch = assets.slice(i, i + batchSize);
            await Promise.allSettled(batch.map(a => this.fetchSingle(a.id)));
        }

        document.getElementById('last-sync-time').textContent = new Date().toLocaleTimeString();
        refreshIcon.classList.remove('syncing');
    },

    async fetchSingle(id) {
        const idx = assets.findIndex(a => a.id === id);
        if (idx === -1) return;
        const asset = assets[idx];
        const cat = this.getCategory(asset.symbol);

        try {
            if (cat === 'CRYPTO') {
                await this.fetchCrypto(idx);
            } else if (asset.symbol === 'GOLD' || asset.symbol === 'SILVER') {
                await this.fetchMetal(idx);
            } else {
                await this.fetchStock(idx, cat);
            }
        } catch (e) {
            console.error(`更新 ${asset.symbol} 失敗:`, e);
            asset.name = "暫時無法讀取數據";
        }

        saveAssets();
        UIManager.render();
    },

    async fetchCrypto(idx) {
        const symbol = assets[idx].symbol.replace('USDT', '').replace('-USD', '');
        const binanceSym = `${symbol}USDT`;

        // Binance 公開 API (支援 CORS)
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`);
        if (!res.ok) throw new Error("Binance API error");
        const data = await res.json();

        assets[idx].price = parseFloat(data.lastPrice);
        assets[idx].name = `${symbol} / Tether`;
        assets[idx].currency = "USD";
    },

    async fetchMetal(idx) {
        // 使用現貨代碼 XAUUSD=X 取得更準確的即時國際金價
        const isGold = assets[idx].symbol === 'GOLD';
        const ticker = isGold ? 'XAUUSD=X' : 'XAGUSD=X';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`;
        const data = await this.fetchWithProxy(url);

        if (data?.chart?.result) {
            const meta = data.chart.result[0].meta;
            let ozPriceUsd = meta.regularMarketPrice;

            if (isGold) {
                // 1 盎司 = 31.1034768 公克
                const gramPriceUsd = ozPriceUsd / 31.1034768;
                // 我們將價格直接轉換為台幣，這樣在 UIManager 顯示時更直覺
                assets[idx].price = gramPriceUsd * usdToTwdRate;
                assets[idx].name = '國際現貨金價 (TWD/g)';
                assets[idx].currency = "TWD";
            } else {
                assets[idx].price = ozPriceUsd * usdToTwdRate;
                assets[idx].name = '國際現貨銀價 (TWD/oz)';
                assets[idx].currency = "TWD";
            }
        }
    },

    async fetchStock(idx, cat) {
        const symbol = assets[idx].symbol;
        let tickers = [symbol];
        if (cat === 'TW' && !symbol.includes('.')) {
            tickers = [`${symbol}.TW`, `${symbol}.TWO`];
        }

        for (const t of tickers) {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=15m&range=1d`;
            const data = await this.fetchWithProxy(url);
            if (data?.chart?.result) {
                const res = data.chart.result[0];
                assets[idx].price = res.meta.regularMarketPrice;
                assets[idx].name = res.meta.shortName || res.meta.longName || symbol;
                assets[idx].currency = res.meta.currency;
                assets[idx].history = res.indicators.quote[0].close.filter(p => p != null).slice(-24);
                return;
            }
        }
    },

    async fetchWithProxy(url) {
        // 使用更穩定的 proxy 順序與格式
        const proxies = [
            `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
            `https://thingproxy.freeboard.io/fetch/${url}`
        ];

        for (const p of proxies) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒超時

                const res = await fetch(p, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!res.ok) continue;

                const text = await res.text();
                if (!text) continue;

                let json;
                try {
                    const outerJson = JSON.parse(text);
                    json = outerJson.contents ? JSON.parse(outerJson.contents) : outerJson;
                } catch (e) {
                    // 如果不是 JSON，嘗試直接解析
                    continue;
                }

                if (json && json.chart) return json;
            } catch (e) {
                console.warn(`Proxy ${p} failed:`, e.name === 'AbortError' ? 'Timeout' : e.message);
                continue;
            }
        }
        return null;
    },

    getCategory(symbol) {
        if (['GOLD', 'SILVER'].includes(symbol)) return 'METAL';
        const cryptos = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP', 'PEPE', 'SHIB'];
        if (symbol.includes('-') || cryptos.includes(symbol)) return 'CRYPTO';
        if (/^\d/.test(symbol) || symbol.includes('.TW') || symbol.includes('.TWO')) return 'TW';
        return 'US';
    }
};

// --- 自動渲染模組 (UI Layer) ---
const UIManager = {
    render() {
        const list = document.getElementById('asset-list');
        list.className = 'asset-grid'; // Reset grid
        list.innerHTML = '';

        const totals = { TW: 0, US: 0, METAL: 0, CRYPTO: 0 };
        let grandTotal = 0;

        // 分組統計
        assets.forEach(a => {
            const cat = PriceService.getCategory(a.symbol);
            const isUSD = a.currency === 'USD' || ['US', 'METAL', 'CRYPTO'].includes(cat);
            const valTwd = (isUSD ? (a.price * usdToTwdRate) : a.price) * a.shares;
            totals[cat] += valTwd;
            grandTotal += valTwd;
        });

        // 渲染每個分類
        Object.keys(CATEGORY_MAP).forEach(catKey => {
            const catAssets = assets.filter(a => PriceService.getCategory(a.symbol) === catKey);
            const section = this.createSection(catKey, catAssets, totals[catKey]);
            list.appendChild(section);
        });

        document.getElementById('total-amount').textContent = `$ ${grandTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        this.updateChart(totals);
    },

    createSection(key, items, subtotal) {
        const config = CATEGORY_MAP[key];
        const div = document.createElement('div');
        div.className = 'category-section';
        div.innerHTML = `
            <div class="category-header">
                <span class="category-title">${config.icon} ${config.title}</span>
                <span class="category-count">${items.length} 項資產</span>
            </div>
            <div class="asset-list">
                ${items.length ? '' : '<div style="color:var(--text-muted);text-align:center;padding:2rem;font-size:0.8rem;">尚無資產</div>'}
            </div>
            <div class="category-footer">
                分類小計 <span class="subtotal-value">$${subtotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
        `;

        const listContainer = div.querySelector('.asset-list');
        items.forEach(a => {
            const card = this.createCard(a);
            listContainer.appendChild(card);
        });

        return div;
    },

    createCard(asset) {
        const cat = PriceService.getCategory(asset.symbol);
        const isUSD = asset.currency === 'USD' || ['US', 'METAL', 'CRYPTO'].includes(cat);
        const unitLabel = asset.symbol === 'GOLD' ? 'g' : (cat === 'CRYPTO' ? 'Unit' : 'Share');

        const displayUnitPrice = asset.price || 0;
        const displayTotalValueTwd = (isUSD ? (displayUnitPrice * usdToTwdRate) : displayUnitPrice) * asset.shares;

        // TradingView Symbol Mapping
        let tvSymbol = asset.symbol;
        if (cat === 'TW') tvSymbol = `TWSE:${asset.symbol.replace('.TW', '').replace('.TWO', '')}`;
        else if (cat === 'CRYPTO') tvSymbol = `BINANCE:${asset.symbol.replace('USDT', '')}USDT`;
        else if (asset.symbol === 'GOLD') tvSymbol = 'GOLD';

        const card = document.createElement('div');
        card.className = 'asset-card';
        card.innerHTML = `
            <div style="font-size: 1.5rem; color: var(--text-muted);"><i class="ph ph-trend-up"></i></div>
            <div class="asset-info">
                <a href="https://www.tradingview.com/symbols/${tvSymbol}" target="_blank" class="tv-link" style="text-decoration:none; display:flex; align-items:center; gap:4px;">
                    <span class="asset-symbol" style="border-bottom: 1px dotted var(--text-muted);">${asset.symbol}</span>
                    <i class="ph ph-arrow-square-out" style="font-size: 0.8rem; color: var(--primary);"></i>
                </a>
                <span class="asset-name">${asset.name || '搜尋中...'}</span>
                <span style="font-size: 0.7rem; color: var(--text-muted); display: block; margin-top: 2px;">
                    ${isUSD ? 'USD $' : 'TWD $'}${displayUnitPrice.toFixed(displayUnitPrice < 1 ? 4 : 2)} / ${unitLabel}
                </span>
            </div>
            <div class="asset-holdings">
                <span class="asset-value-main">$${displayTotalValueTwd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                <span class="asset-value-sub">${asset.shares.toLocaleString()} ${unitLabel}</span>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn-remove" onclick="removeAsset(${asset.id})">
                    <i class="ph ph-trash"></i>
                </button>
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.btn-remove') || e.target.closest('.tv-link')) return;
            editShares(asset.id);
        });

        return card;
    },

    updateChart(totals) {
        const ctx = document.getElementById('assetChart').getContext('2d');
        const labels = Object.values(CATEGORY_MAP).map(c => c.title);
        const data = Object.keys(CATEGORY_MAP).map(k => totals[k]);
        const colors = Object.values(CATEGORY_MAP).map(c => c.color);

        if (assetChart) {
            assetChart.data.datasets[0].data = data;
            assetChart.update();
        } else {
            assetChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: colors,
                        borderColor: 'transparent',
                        borderWidth: 0,
                        hoverOffset: 12 // 懸停彈出距離
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '75%',
                    layout: {
                        padding: 15 // 重要：增加內距避免 hover 時圓弧超框
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(15, 23, 42, 0.9)',
                            padding: 12,
                            cornerRadius: 10,
                            callbacks: {
                                label: (ctx) => ` $${ctx.raw.toLocaleString()}`
                            }
                        }
                    }
                }
            });
        }
    }
};

// --- 全域工具函數 (供 HTML 呼叫) ---
window.removeAsset = function (id) {
    if (!confirm("確定要刪除此資產？")) return;
    assets = assets.filter(a => a.id !== id);
    saveAssets();
    UIManager.render();
};

window.editShares = function (id) {
    const asset = assets.find(a => a.id === id);
    if (!asset) return;
    const newVal = prompt(`修改 ${asset.symbol} 持有數量:`, asset.shares);
    if (newVal !== null && !isNaN(parseFloat(newVal))) {
        asset.shares = parseFloat(newVal);
        saveAssets();
        UIManager.render();
        PriceService.fetchSingle(id);
    }
};

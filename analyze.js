// pages/api/analyze.js

const crypto = require('crypto');
const fetch = require('node-fetch');

// ========= CLASS DEFINITION START =========

const VALIDATION_PATTERNS = {
  CONTRACT_ADDRESS: /^0x[a-fA-F0-9]{40}$/,
  SOLANA_ADDRESS: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  COIN_ID: /^[a-z0-9-]+$/,
  CHAIN: /^(eth|sol)$/,
};

const CONFIG = {
  API_KEYS: {
    COINGECKO: process.env.CG_KEY,
    ETHERSCAN: process.env.ES_KEY,
    HELIUS: process.env.HL_KEY,
    DEXSCREENER: null
  },
  CACHE_TTL: 300000,
  SECURITY: {
    MAX_REQUESTS_PER_MINUTE: 100,
    ENCRYPT_CACHE: process.env.NODE_ENV === 'production',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
    API_TIMEOUT: 10000,
    MAX_RETRIES: 3
  }
};

class CryptoRiskAnalyzer {
  constructor() {
    this.cache = new Map();
    this.requestCounts = new Map();
  }

  _validateInput(coinId, contractAddress, chain) {
    const errors = [];
    if (!VALIDATION_PATTERNS.COIN_ID.test(coinId)) errors.push('Invalid coin ID format');
    if (chain === 'eth' && !VALIDATION_PATTERNS.CONTRACT_ADDRESS.test(contractAddress)) errors.push('Invalid Ethereum contract address');
    if (chain === 'sol' && !VALIDATION_PATTERNS.SOLANA_ADDRESS.test(contractAddress)) errors.push('Invalid Solana token address');
    if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);
  }

  _calculateGreedScore(marketData, chainData) {
    const volumeSpike = Math.min(100, ((marketData.volume_24h / marketData.avg_volume_7d) - 1) * 40);
    const priceSurge = Math.min(100, ((marketData.current_price / marketData.avg_price_7d) - 1) * 100);
    const whaleDominance = Math.min(100, chainData.top_10_holders * 1.5);
    return Math.round((volumeSpike * 0.25) + (priceSurge * 0.3) + (whaleDominance * 0.25));
  }

  _calculateDecentralization(chainData) {
    const weighted = (chainData.top_1_pct * 0.65) + (chainData.top_10_pct * 0.25) + (chainData.top_100_pct * 0.10);
    return Math.round(Math.max(0, 100 - weighted));
  }

  _calculateRetailScore(chainData) {
    const holderFactor = Math.min(10, Math.log10(chainData.total_holders)) * 2;
    return Math.round(Math.max(0, (chainData.retail_pct * 1.5) - (chainData.top_1_pct * 0.8) + holderFactor));
  }

  _calculateVolatility(marketData) {
    const priceChange = Math.abs(marketData.price_change_percentage_24h);
    const volumeRatio = marketData.volume_24h / marketData.market_cap;
    return Math.round(Math.min(100, (priceChange * 1.5) + ((1 - volumeRatio) * 30)));
  }

  _calculateLiquidity(marketData, dexData) {
    const liquidityRatio = dexData.liquidity / marketData.market_cap;
    let multiplier = 175;
    if (marketData.market_cap < 1e8) multiplier = 200;
    if (marketData.market_cap > 1e9) multiplier = 150;
    return Math.round(Math.min(100, liquidityRatio * multiplier));
  }

  async _fetchCoinGeckoData(coinId) {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=false&sparkline=false`;
    try {
      const response = await fetch(url, {
        headers: { 'x-cg-demo-api-key': CONFIG.API_KEYS.COINGECKO },
        timeout: CONFIG.SECURITY.API_TIMEOUT
      });
      if (!response.ok) throw new Error(`CoinGecko API error: ${response.status}`);
      const data = await response.json();
      return {
        current_price: data.market_data.current_price.usd,
        price_change_percentage_24h: data.market_data.price_change_percentage_24h,
        market_cap: data.market_data.market_cap.usd,
        volume_24h: data.market_data.total_volume.usd,
        circulating_supply: data.market_data.circulating_supply,
        total_supply: data.market_data.total_supply,
        contract_address: data.platforms?.ethereum,
        avg_volume_7d: data.market_data.total_volume.usd / 7,
        avg_price_7d: data.market_data.current_price.usd
      };
    } catch (error) {
      console.error('[CoinGecko]', error);
      throw new Error('Failed to fetch market data');
    }
  }

  async _fetchEtherscanData(contractAddress) {
    const url = `https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${contractAddress}&page=1&offset=100&apikey=${CONFIG.API_KEYS.ETHERSCAN}`;
    try {
      const response = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
      if (!response.ok) throw new Error(`Etherscan API error: ${response.status}`);
      const data = await response.json();
      const holders = data.result;
      const totalSupply = holders.reduce((sum, h) => sum + parseFloat(h.balance), 0);
      return {
        top_1_pct: this._calculateHolderPercentage(holders, 0.01, totalSupply),
        top_10_pct: this._calculateHolderPercentage(holders, 0.10, totalSupply),
        top_100_pct: this._calculateHolderPercentage(holders.slice(0, 100), 1, totalSupply),
        top_10_holders: this._calculateHolderPercentage(holders.slice(0, 10), 1, totalSupply),
        retail_pct: this._calculateHolderPercentage(
          holders.filter(h => (h.balance / totalSupply) < 0.001),
          1,
          totalSupply
        ),
        total_holders: holders.length
      };
    } catch (error) {
      console.error('[Etherscan]', error);
      throw new Error('Failed to fetch holder data');
    }
  }

  async _fetchSolanaData(contractAddress) {
    try {
      const url = `https://api.helius.xyz/v0/token-transfers?api-key=${CONFIG.API_KEYS.HELIUS}&token=${contractAddress}&limit=1000`;
      const response = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
      if (!response.ok) throw new Error(`Helius API error: ${response.status}`);
      const data = await response.json();
      const recentTxs = data.filter(tx => (Date.now() - tx.timestamp) < 86400000);
      return {
        active_wallets_24h: new Set(recentTxs.map(tx => tx.fromUserAccount)).size,
        tx_count_24h: recentTxs.length,
        unique_receivers_24h: new Set(recentTxs.map(tx => tx.toUserAccount)).size
      };
    } catch (error) {
      console.error('[Helius]', error);
      throw new Error('Failed to fetch Solana activity data');
    }
  }

  async _fetchDexScreenerData(contractAddress) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/pairs/${contractAddress}`;
      const response = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
      if (!response.ok) throw new Error(`DexScreener API error: ${response.status}`);
      const data = await response.json();
      const totalLiquidity = data.pairs.reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0);
      const top5Liquidity = data.pairs
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
        .slice(0, 5)
        .reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0);
      return {
        liquidity: totalLiquidity,
        top_5_pool_concentration: totalLiquidity > 0 ? top5Liquidity / totalLiquidity : 0
      };
    } catch (error) {
      console.error('[DexScreener]', error);
      throw new Error('Failed to fetch liquidity data');
    }
  }

  _calculateHolderPercentage(holders, percentage, totalSupply) {
    const count = percentage <= 1 ? Math.ceil(holders.length * percentage) : holders.length;
    const sum = holders.slice(0, count).reduce((s, h) => s + parseFloat(h.balance), 0);
    return (sum / totalSupply) * 100;
  }

  _checkRateLimit(clientId) {
    const now = Date.now();
    const windowStart = now - 60000;
    if (!this.requestCounts.has(clientId)) this.requestCounts.set(clientId, []);
    const timestamps = this.requestCounts.get(clientId).filter(t => t > windowStart);
    timestamps.push(now);
    this.requestCounts.set(clientId, timestamps);
    if (timestamps.length > CONFIG.SECURITY.MAX_REQUESTS_PER_MINUTE) {
      throw new Error('Rate limit exceeded');
    }
  }

  async analyze(coinId, contractAddress, chain = 'eth', clientId = 'default') {
    const startTime = Date.now();
    try {
      this._validateInput(coinId, contractAddress, chain);
      this._checkRateLimit(clientId);
      const cacheKey = crypto.createHash('sha256').update(`${coinId}:${contractAddress}:${chain}`).digest('hex');
      if (this.cache.has(cacheKey)) return { ...this.cache.get(cacheKey), fromCache: true };

      const [marketData, chainData, dexData] = await Promise.all([
        this._fetchCoinGeckoData(coinId),
        chain === 'eth' ? this._fetchEtherscanData(contractAddress) : this._fetchSolanaData(contractAddress),
        this._fetchDexScreenerData(contractAddress)
      ]);

      const result = {
        basic: {
          price: marketData.current_price,
          price_change_24h: marketData.price_change_percentage_24h,
          market_cap: marketData.market_cap,
          volume_24h: marketData.volume_24h,
          contract_address: contractAddress
        },
        scores: {
          greed: this._calculateGreedScore(marketData, chainData),
          decentralization: this._calculateDecentralization(chainData),
          retail: this._calculateRetailScore(chainData),
          volatility: this._calculateVolatility(marketData),
          liquidity: this._calculateLiquidity(marketData, dexData)
        },
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };

      if (CONFIG.SECURITY.ENCRYPT_CACHE) {
        this.cache.set(cacheKey, result);
      }

      return result;
    } catch (error) {
      console.error(`[Analyze] ${error.message}`);
      return {
        error: true,
        message: error.message,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ========= CLASS DEFINITION END =========

const analyzer = new CryptoRiskAnalyzer();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests allowed' });
  }

  try {
    const { coinId, contractAddress, chain, clientId } = req.body;

    if (!coinId || !contractAddress || !chain) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await analyzer.analyze(coinId, contractAddress, chain, clientId || 'default');

    if (result.error) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[API Error]', err);
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
}

// api/analyze.js
//
// Drop-in replacement that lets clients send ONLY a plain-language coin
// name ( “uniswap”, “dogecoin”, … ) or still send the old params.
// – coinName    (preferred single field)
// – coinId      (CoinGecko slug)            » optional
// – contractAddress + chain (“eth”|“sol”)   » optional
//
// The function will auto-discover whatever is missing and continue.
// Tested on Vercel Node 18 with `"type":"module"` in package.json.

import crypto from 'crypto';
import fetch  from 'node-fetch';

// ────────────────────────────────────────────────────────────
// Config & validation
// ────────────────────────────────────────────────────────────
const VALIDATION_PATTERNS = {
  CONTRACT_ADDRESS : /^0x[a-fA-F0-9]{40}$/,
  SOLANA_ADDRESS   : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  COIN_ID          : /^[a-z0-9-]+$/,
  CHAIN            : /^(eth|sol)$/
};

const CONFIG = {
  API_KEYS : {
    COINGECKO  : process.env.CG_KEY,
    ETHERSCAN  : process.env.ES_KEY,
    HELIUS     : process.env.HL_KEY,
    DEXSCREENER: null
  },
  CACHE_TTL : 300_000,
  SECURITY  : {
    MAX_REQUESTS_PER_MINUTE: 100,
    ENCRYPT_CACHE          : process.env.NODE_ENV === 'production',
    ALLOWED_ORIGINS        : process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
    API_TIMEOUT            : 10_000,
    MAX_RETRIES            : 3
  }
};

// ────────────────────────────────────────────────────────────
// Helper – resolve data from CoinGecko
// ────────────────────────────────────────────────────────────
async function slugFromName (name) {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { 'x-cg-demo-api-key': CONFIG.API_KEYS.COINGECKO },
    timeout: CONFIG.SECURITY.API_TIMEOUT
  });
  if (!res.ok) throw new Error(`CoinGecko search failed (${res.status})`);
  const data = await res.json();
  if (!data.coins?.length) throw new Error('Coin not found on CoinGecko');
  return data.coins[0].id;            // first hit → slug
}

async function contractAndChainFromSlug (slug) {
  const url = `https://api.coingecko.com/api/v3/coins/${slug}?localization=false`;
  const res = await fetch(url, {
    headers: { 'x-cg-demo-api-key': CONFIG.API_KEYS.COINGECKO },
    timeout: CONFIG.SECURITY.API_TIMEOUT
  });
  if (!res.ok) throw new Error(`CoinGecko lookup failed (${res.status})`);
  const d = await res.json();

  if (d.platforms?.ethereum) {
    return { contractAddress: d.platforms.ethereum, chain: 'eth' };
  }
  if (d.platforms?.solana) {
    return { contractAddress: d.platforms.solana, chain: 'sol' };
  }
  // native L1 coin (btc, eth, sol, …) – no contract, no chain specific scores
  return { contractAddress: null, chain: null };
}

async function resolveCoinId (contractAddress, chain) {
  const base = chain === 'eth' ? 'ethereum' : 'solana';
  const url  = `https://api.coingecko.com/api/v3/coins/${base}/contract/${contractAddress}`;
  const res  = await fetch(url, {
    headers: { 'x-cg-demo-api-key': CONFIG.API_KEYS.COINGECKO },
    timeout: CONFIG.SECURITY.API_TIMEOUT
  });
  if (!res.ok) throw new Error(`CoinGecko contract-to-slug failed (${res.status})`);
  const data = await res.json();
  return data.id;
}

// ────────────────────────────────────────────────────────────
// Analyzer class
// ────────────────────────────────────────────────────────────
class CryptoRiskAnalyzer {
  constructor () {
    this.cache         = new Map();
    this.requestCounts = new Map();
  }

  _validateInput (coinId, contractAddress, chain) {
    const errors = [];
    if (coinId && !VALIDATION_PATTERNS.COIN_ID.test(coinId))
      errors.push('Invalid coin ID format');
    if (contractAddress && chain === 'eth' &&
        !VALIDATION_PATTERNS.CONTRACT_ADDRESS.test(contractAddress))
      errors.push('Invalid Ethereum contract address');
    if (contractAddress && chain === 'sol' &&
        !VALIDATION_PATTERNS.SOLANA_ADDRESS.test(contractAddress))
      errors.push('Invalid Solana token address');
    if (errors.length) throw new Error(`Validation failed: ${errors.join(', ')}`);
  }

  // ── metric helpers (unchanged) ───────────────────────────
  _calculateGreedScore (m, c) {
    const volumeSpike    = Math.min(100, ((m.volume_24h / m.avg_volume_7d) - 1) * 40);
    const priceSurge     = Math.min(100, ((m.current_price / m.avg_price_7d) - 1) * 100);
    const whaleDominance = Math.min(100, c.top_10_holders * 1.5);
    return Math.round(volumeSpike * .25 + priceSurge * .3 + whaleDominance * .25);
  }

  _calculateDecentralization (c) {
    const w = c.top_1_pct * .65 + c.top_10_pct * .25 + c.top_100_pct * .10;
    return Math.round(Math.max(0, 100 - w));
  }

  _calculateRetailScore (c) {
    const holderFactor = Math.min(10, Math.log10(c.total_holders || 1)) * 2;
    return Math.round(Math.max(0, (c.retail_pct * 1.5) - (c.top_1_pct * .8) + holderFactor));
  }

  _calculateVolatility (m) {
    const priceChange  = Math.abs(m.price_change_percentage_24h);
    const volumeRatio  = m.volume_24h / m.market_cap;
    return Math.round(Math.min(100, priceChange * 1.5 + (1 - volumeRatio) * 30));
  }

  _calculateLiquidity (m, d) {
    const liquidityRatio = d.liquidity / m.market_cap;
    let multiplier = 175;
    if (m.market_cap < 1e8)  multiplier = 200;
    if (m.market_cap > 1e9)  multiplier = 150;
    return Math.round(Math.min(100, liquidityRatio * multiplier));
  }

  // ── external fetches (unchanged) ─────────────────────────
  async _fetchCoinGeckoData (coinId) {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}` +
                '?localization=false&tickers=true&market_data=true' +
                '&community_data=false&developer_data=false&sparkline=false';

    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': CONFIG.API_KEYS.COINGECKO },
      timeout: CONFIG.SECURITY.API_TIMEOUT
    });
    if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
    const d = await res.json();
    return {
      current_price             : d.market_data.current_price.usd,
      price_change_percentage_24h: d.market_data.price_change_percentage_24h,
      market_cap                : d.market_data.market_cap.usd,
      volume_24h                : d.market_data.total_volume.usd,
      circulating_supply        : d.market_data.circulating_supply,
      total_supply              : d.market_data.total_supply,
      contract_address          : d.platforms?.ethereum,
      avg_volume_7d             : d.market_data.total_volume.usd / 7,
      avg_price_7d              : d.market_data.current_price.usd
    };
  }

  async _fetchEtherscanData (contractAddress) {
    const url = `https://api.etherscan.io/api?module=token&action=tokenholderlist` +
                `&contractaddress=${contractAddress}&page=1&offset=100` +
                `&apikey=${CONFIG.API_KEYS.ETHERSCAN}`;

    const res = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`Etherscan API error: ${res.status}`);
    const data      = await res.json();
    const holders   = data.result;
    const totalSupp = holders.reduce((s, h) => s + parseFloat(h.balance), 0);

    return {
      top_1_pct : this._holderPct(holders, 0.01, totalSupp),
      top_10_pct: this._holderPct(holders, 0.10, totalSupp),
      top_100_pct: this._holderPct(holders.slice(0,100), 1, totalSupp),
      top_10_holders: this._holderPct(holders.slice(0,10), 1, totalSupp),
      retail_pct: this._holderPct(
        holders.filter(h => (h.balance / totalSupp) < 0.001), 1, totalSupp),
      total_holders: holders.length
    };
  }

  async _fetchSolanaData (contractAddress) {
    const url = `https://api.helius.xyz/v0/token-transfers` +
                `?api-key=${CONFIG.API_KEYS.HELIUS}&token=${contractAddress}&limit=1000`;

    const res = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
    const data      = await res.json();
    const recentTxs = data.filter(tx => (Date.now() - tx.timestamp) < 86_400_000);

    return {
      active_wallets_24h : new Set(recentTxs.map(tx => tx.fromUserAccount)).size,
      tx_count_24h       : recentTxs.length,
      unique_receivers_24h: new Set(recentTxs.map(tx => tx.toUserAccount)).size,
      // map to ETH-style fields so later calculations work
      top_1_pct  : 0, top_10_pct: 0, top_100_pct: 0,
      top_10_holders: 0, retail_pct: 0, total_holders: 0
    };
  }

  async _fetchDexScreenerData (contractAddress) {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${contractAddress}`;
    const res = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);
    const d = await res.json();

    const totalLiq = d.pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
    const top5Liq  = d.pairs
      .sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))
      .slice(0,5)
      .reduce((s,p)=> s + (p.liquidity?.usd||0), 0);

    return {
      liquidity: totalLiq,
      top_5_pool_concentration: totalLiq ? top5Liq / totalLiq : 0
    };
  }

  _holderPct (holders, pct, total) {
    const count = pct <= 1 ? Math.ceil(holders.length * pct) : holders.length;
    const sum   = holders.slice(0, count)
                    .reduce((s,h)=> s + parseFloat(h.balance), 0);
    return (sum / total) * 100;
  }

  _checkRateLimit (clientId) {
    const now   = Date.now();
    const start = now - 60_000;
    if (!this.requestCounts.has(clientId)) this.requestCounts.set(clientId, []);
    const ts = this.requestCounts.get(clientId).filter(t => t > start);
    ts.push(now);
    this.requestCounts.set(clientId, ts);
    if (ts.length > CONFIG.SECURITY.MAX_REQUESTS_PER_MINUTE)
      throw new Error('Rate limit exceeded');
  }

  // ─────────────────────────────────────────────────────────
  async analyze (coinId, contractAddress, chain = 'eth', clientId = 'default', coinName = '') {
    const t0 = Date.now();
    try {
      // ── auto-fill missing pieces ──────────────────────────
      if (!coinId && coinName) {
        coinId = await slugFromName(coinName);
      }

      if ((!contractAddress || !chain) && coinId) {
        const info = await contractAndChainFromSlug(coinId);
        contractAddress = contractAddress || info.contractAddress;
        chain           = chain           || info.chain;
      }

      if (!coinId && contractAddress && chain) {
        coinId = await resolveCoinId(contractAddress, chain);
      }

      // allow native coins with no contract
      if (contractAddress && chain) {
        this._validateInput(coinId, contractAddress, chain);
      } else {
        // still validate coinId itself
        this._validateInput(coinId, null, null);
      }

      this._checkRateLimit(clientId);

      const cacheKey = crypto.createHash('sha256')
        .update(`${coinId}:${contractAddress}:${chain}`).digest('hex');
      if (this.cache.has(cacheKey))
        return { ...this.cache.get(cacheKey), fromCache: true };

      // ── fetch data in parallel, but only if we have a contract ──
      const marketP = this._fetchCoinGeckoData(coinId);
      let chainP, dexP;

      if (contractAddress && chain) {
        chainP = chain === 'eth'
          ? this._fetchEtherscanData(contractAddress)
          : this._fetchSolanaData(contractAddress);
        dexP   = this._fetchDexScreenerData(contractAddress);
      } else {
        // native coin → fake minimal objects
        chainP = Promise.resolve({
          top_1_pct:0, top_10_pct:0, top_100_pct:0,
          top_10_holders:0, retail_pct:0, total_holders:0
        });
        dexP   = Promise.resolve({ liquidity:0, top_5_pool_concentration:0 });
      }

      const [marketData, chainData, dexData] = await Promise.all([marketP, chainP, dexP]);

      const result = {
        basic : {
          name          : coinName || coinId,
          price         : marketData.current_price,
          price_change_24h: marketData.price_change_percentage_24h,
          market_cap    : marketData.market_cap,
          volume_24h    : marketData.volume_24h,
          contract_address: contractAddress
        },
        scores: {
          greed           : this._calculateGreedScore(marketData, chainData),
          decentralization: this._calculateDecentralization(chainData),
          retail          : this._calculateRetailScore(chainData),
          volatility      : this._calculateVolatility(marketData),
          liquidity       : this._calculateLiquidity(marketData, dexData)
        },
        processingTime: Date.now() - t0,
        timestamp     : new Date().toISOString()
      };

      if (CONFIG.SECURITY.ENCRYPT_CACHE) {
        this.cache.set(cacheKey, result);
        // naive TTL eviction
        setTimeout(()=> this.cache.delete(cacheKey), CONFIG.CACHE_TTL);
      }

      return result;
    } catch (err) {
      console.error('[Analyze]', err);
      return {
        error: true,
        message: err.message,
        processingTime: Date.now() - t0,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// ────────────────────────────────────────────────────────────
// API handler (Vercel / Netlify style)
// ────────────────────────────────────────────────────────────
const analyzer = new CryptoRiskAnalyzer();

export default async function handler (req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests allowed' });
  }

  try {
    const {
      coinId         = '',
      coinName       = '',
      contractAddress= '',
      chain          = '',
      clientId       = 'default'
    } = req.body || {};

    if (!coinId && !coinName && !contractAddress) {
      return res.status(400).json({ error: 'Provide coinName, coinId or contractAddress' });
    }

    const data = await analyzer.analyze(
      coinId, contractAddress, chain, clientId, coinName
    );

    const status = data.error ? 400 : 200;
    return res.status(status).json(data);
  } catch (err) {
    console.error('[API Error]', err);
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
}

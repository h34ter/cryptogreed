// api/analyze.js
// Complete file – includes cgHeaders() helper so CoinGecko calls work
// with or without an API key, plus the earlier “search-by-name” logic.

import crypto from 'crypto';
import fetch  from 'node-fetch';

/* ──────────────────────────────────────────────────────────
   Config & Validation
   ────────────────────────────────────────────────────────── */
const VALIDATION_PATTERNS = {
  CONTRACT_ADDRESS : /^0x[a-fA-F0-9]{40}$/,
  SOLANA_ADDRESS   : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  COIN_ID          : /^[a-z0-9-]+$/,
  CHAIN            : /^(eth|sol)$/
};

const CONFIG = {
  API_KEYS : {
    COINGECKO  : process.env.CG_KEY,   // leave undefined for free tier
    ETHERSCAN  : process.env.ES_KEY,
    HELIUS     : process.env.HL_KEY,
    DEXSCREENER: null
  },
  CACHE_TTL : 300_000,
  SECURITY  : {
    MAX_REQUESTS_PER_MINUTE: 100,
    ENCRYPT_CACHE          : process.env.NODE_ENV === 'production',
    ALLOWED_ORIGINS        : process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
    API_TIMEOUT            : 10_000
  }
};

/* ──────────────────────────────────────────────────────────
   Helper – build correct headers for CoinGecko
   ────────────────────────────────────────────────────────── */
function cgHeaders () {
  if (!CONFIG.API_KEYS.COINGECKO) return {};            // free tier → no header
  const headerName = CONFIG.API_KEYS.COINGECKO.startsWith('cg-')
    ? 'x-cg-pro-api-key'                                // paid key
    : 'x-cg-demo-api-key';                              // demo key
  return { [headerName]: CONFIG.API_KEYS.COINGECKO };
}

/* ──────────────────────────────────────────────────────────
   CoinGecko lookup helpers
   ────────────────────────────────────────────────────────── */
async function slugFromName (name) {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: cgHeaders(), timeout: CONFIG.SECURITY.API_TIMEOUT });
  if (!res.ok) throw new Error(`CoinGecko search failed (${res.status})`);
  const data = await res.json();
  if (!data.coins?.length) throw new Error('Coin not found on CoinGecko');
  return data.coins[0].id;                        // slug, e.g. "uniswap"
}

async function contractAndChainFromSlug (slug) {
  const url = `https://api.coingecko.com/api/v3/coins/${slug}?localization=false`;
  const res = await fetch(url, { headers: cgHeaders(), timeout: CONFIG.SECURITY.API_TIMEOUT });
  if (!res.ok) throw new Error(`CoinGecko lookup failed (${res.status})`);
  const d = await res.json();
  if (d.platforms?.ethereum) return { contractAddress: d.platforms.ethereum, chain: 'eth' };
  if (d.platforms?.solana)   return { contractAddress: d.platforms.solana,   chain: 'sol' };
  return { contractAddress: null, chain: null };        // native coins
}

async function resolveCoinId (contractAddress, chain) {
  const base = chain === 'eth' ? 'ethereum' : 'solana';
  const url  = `https://api.coingecko.com/api/v3/coins/${base}/contract/${contractAddress}`;
  const res  = await fetch(url, { headers: cgHeaders(), timeout: CONFIG.SECURITY.API_TIMEOUT });
  if (!res.ok) throw new Error(`CoinGecko contract→slug failed (${res.status})`);
  const data = await res.json();
  return data.id;
}

/* ──────────────────────────────────────────────────────────
   Analyzer Class
   ────────────────────────────────────────────────────────── */
class CryptoRiskAnalyzer {
  constructor () {
    this.cache         = new Map();
    this.requestCounts = new Map();
  }

  _validateInput (coinId, contractAddress, chain) {
    const errs = [];
    if (coinId && !VALIDATION_PATTERNS.COIN_ID.test(coinId)) errs.push('Bad coinId');
    if (contractAddress && chain === 'eth' &&
        !VALIDATION_PATTERNS.CONTRACT_ADDRESS.test(contractAddress)) errs.push('Bad ETH address');
    if (contractAddress && chain === 'sol' &&
        !VALIDATION_PATTERNS.SOLANA_ADDRESS.test(contractAddress))   errs.push('Bad SOL address');
    if (errs.length) throw new Error(`Validation failed: ${errs.join(', ')}`);
  }

  /* ── metric helpers (unchanged from your original) ── */
  _calculateGreedScore (m, c) {
    const vol = Math.min(100, ((m.volume_24h / m.avg_volume_7d) - 1) * 40);
    const pric= Math.min(100, ((m.current_price / m.avg_price_7d) - 1) * 100);
    const whale = Math.min(100, c.top_10_holders * 1.5);
    return Math.round(vol * .25 + pric * .3 + whale * .25);
  }
  _calculateDecentralization (c) {
    const w = c.top_1_pct * .65 + c.top_10_pct * .25 + c.top_100_pct * .1;
    return Math.round(Math.max(0, 100 - w));
  }
  _calculateRetailScore (c) {
    const h = Math.min(10, Math.log10(c.total_holders || 1)) * 2;
    return Math.round(Math.max(0, (c.retail_pct * 1.5) - (c.top_1_pct * .8) + h));
  }
  _calculateVolatility (m) {
    const pc = Math.abs(m.price_change_percentage_24h);
    const vr = m.volume_24h / m.market_cap;
    return Math.round(Math.min(100, pc * 1.5 + (1 - vr) * 30));
  }
  _calculateLiquidity (m, d) {
    const lr = d.liquidity / m.market_cap;
    let mult = 175;
    if (m.market_cap < 1e8) mult = 200;
    if (m.market_cap > 1e9) mult = 150;
    return Math.round(Math.min(100, lr * mult));
  }

  /* ── external fetches ── */
  async _fetchCoinGeckoData (coinId) {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}` +
      '?localization=false&tickers=true&market_data=true&community_data=false' +
      '&developer_data=false&sparkline=false';
    const res = await fetch(url, { headers: cgHeaders(), timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
    const d = await res.json();
    return {
      current_price: d.market_data.current_price.usd,
      price_change_percentage_24h: d.market_data.price_change_percentage_24h,
      market_cap  : d.market_data.market_cap.usd,
      volume_24h  : d.market_data.total_volume.usd,
      circulating_supply: d.market_data.circulating_supply,
      total_supply      : d.market_data.total_supply,
      contract_address  : d.platforms?.ethereum,
      avg_volume_7d     : d.market_data.total_volume.usd / 7,
      avg_price_7d      : d.market_data.current_price.usd
    };
  }

  async _fetchEtherscanData (contractAddress) {
    const url = `https://api.etherscan.io/api?module=token&action=tokenholderlist&contractaddress=${contractAddress}&page=1&offset=100&apikey=${CONFIG.API_KEYS.ETHERSCAN}`;
    const res = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`Etherscan API error: ${res.status}`);
    const data    = await res.json();
    const holders = data.result;
    const total   = holders.reduce((s,h)=> s + parseFloat(h.balance),0);
    const pct = (hs,p)=> (hs.slice(0,p).reduce((s,h)=>s+parseFloat(h.balance),0)/total)*100;
    return {
      top_1_pct       : pct(holders, Math.ceil(holders.length*0.01)),
      top_10_pct      : pct(holders, Math.ceil(holders.length*0.10)),
      top_100_pct     : pct(holders.slice(0,100), 100),
      top_10_holders  : pct(holders.slice(0,10), 10),
      retail_pct      : pct(holders.filter(h=> (h.balance/total)<0.001), holders.length),
      total_holders   : holders.length
    };
  }

  async _fetchSolanaData (contractAddress) {
    const url = `https://api.helius.xyz/v0/token-transfers?api-key=${CONFIG.API_KEYS.HELIUS}&token=${contractAddress}&limit=1000`;
    const res = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
    const data = await res.json();
    const recent = data.filter(tx => Date.now() - tx.timestamp < 86_400_000);
    return {
      active_wallets_24h : new Set(recent.map(tx=>tx.fromUserAccount)).size,
      tx_count_24h       : recent.length,
      unique_receivers_24h: new Set(recent.map(tx=>tx.toUserAccount)).size,
      top_1_pct:0, top_10_pct:0, top_100_pct:0,
      top_10_holders:0, retail_pct:0, total_holders:0
    };
  }

  async _fetchDexScreenerData (contractAddress) {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${contractAddress}`;
    const res = await fetch(url, { timeout: CONFIG.SECURITY.API_TIMEOUT });
    if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`);
    const d = await res.json();
    const tot = d.pairs.reduce((s,p)=> s+(p.liquidity?.usd||0),0);
    const top = d.pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))
                       .slice(0,5)
                       .reduce((s,p)=> s+(p.liquidity?.usd||0),0);
    return { liquidity: tot, top_5_pool_concentration: tot? top/tot : 0 };
  }

  _checkRateLimit (clientId) {
    const now = Date.now(), win = now - 60_000;
    if (!this.requestCounts.has(clientId)) this.requestCounts.set(clientId, []);
    const arr = this.requestCounts.get(clientId).filter(t=> t>win);
    arr.push(now); this.requestCounts.set(clientId, arr);
    if (arr.length > CONFIG.SECURITY.MAX_REQUESTS_PER_MINUTE) throw new Error('Rate limit');
  }

  /* ─────────────────────────────────────────────── */
  async analyze (coinId, contractAddress, chain='eth', clientId='default', coinName='') {
    const t0 = Date.now();
    try {
      // fill missing pieces
      if (!coinId && coinName)          coinId = await slugFromName(coinName);
      if ((!contractAddress || !chain) && coinId) {
        const info = await contractAndChainFromSlug(coinId);
        contractAddress = contractAddress || info.contractAddress;
        chain           = chain           || info.chain;
      }
      if (!coinId && contractAddress && chain) coinId = await resolveCoinId(contractAddress, chain);

      if (contractAddress && chain) this._validateInput(coinId, contractAddress, chain);
      else                          this._validateInput(coinId, null, null);

      this._checkRateLimit(clientId);

      const cacheKey = crypto.createHash('sha256').update(`${coinId}:${contractAddress}:${chain}`).digest('hex');
      if (this.cache.has(cacheKey)) return { ...this.cache.get(cacheKey), fromCache:true };

      // fetch in parallel
      const marketP = this._fetchCoinGeckoData(coinId);
      const chainP  = contractAddress
        ? (chain==='eth' ? this._fetchEtherscanData(contractAddress)
                         : this._fetchSolanaData(contractAddress))
        : Promise.resolve({
            top_1_pct:0, top_10_pct:0, top_100_pct:0,
            top_10_holders:0, retail_pct:0, total_holders:0
          });
      const dexP    = contractAddress ? this._fetchDexScreenerData(contractAddress)
                                      : Promise.resolve({ liquidity:0, top_5_pool_concentration:0 });

      const [m,c,d] = await Promise.all([marketP, chainP, dexP]);

      const res = {
        basic : {
          name             : coinName || coinId,
          price            : m.current_price,
          price_change_24h : m.price_change_percentage_24h,
          market_cap       : m.market_cap,
          volume_24h       : m.volume_24h,
          contract_address : contractAddress
        },
        scores: {
          greed           : this._calculateGreedScore(m, c),
          decentralization: this._calculateDecentralization(c),
          retail          : this._calculateRetailScore(c),
          volatility      : this._calculateVolatility(m),
          liquidity       : this._calculateLiquidity(m, d)
        },
        processingTime: Date.now() - t0,
        timestamp     : new Date().toISOString()
      };

      if (CONFIG.SECURITY.ENCRYPT_CACHE) {
        this.cache.set(cacheKey, res);
        setTimeout(()=> this.cache.delete(cacheKey), CONFIG.CACHE_TTL);
      }
      return res;

    } catch (err) {
      console.error('[Analyze]', err);
      return { error:true, message:err.message, processingTime:Date.now()-t0, timestamp:new Date().toISOString() };
    }
  }
}

/* ──────────────────────────────────────────────────────────
   API Handler (Vercel style)
   ────────────────────────────────────────────────────────── */
const analyzer = new CryptoRiskAnalyzer();

export default async function handler (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error:'Only POST allowed' });

  try {
    const {
      coinId='',
      coinName='',
      contractAddress='',
      chain='',
      clientId='default'
    } = req.body || {};

    if (!coinId && !coinName && !contractAddress)
      return res.status(400).json({ error:'Provide coinName, coinId or contractAddress' });

    const data   = await analyzer.analyze(coinId, contractAddress, chain, clientId, coinName);
    const status = data.error ? 400 : 200;
    return res.status(status).json(data);

  } catch (err) {
    console.error('[API Error]', err);
    return res.status(500).json({ error:'Server error', message:err.message });
  }
}

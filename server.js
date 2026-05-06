const https = require('https');
const http = require('http');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_KEY || 'd7tda9hr01qugn0a7h10d7tda9hr01qugn0a7h1g';

// Cache מחירים 4 דקות
const cache = {};
const CACHE_TTL = 4 * 60 * 1000;

function get(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers: { 'User-Agent': 'AZENO/1.0' } }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Finnhub quote לטיקר בודד
async function fetchFinnhub(ticker) {
  const now = Date.now();
  if (cache[ticker] && now - cache[ticker].ts < CACHE_TTL) return cache[ticker].data;
  try {
    const body = await get('finnhub.io', `/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
    const q = JSON.parse(body);
    if (!q.c || q.c === 0) return null;
    const result = {
      symbol: ticker,
      regularMarketPrice: q.c,
      regularMarketChangePercent: q.dp,
      regularMarketVolume: 0,
      shortName: ticker,
      marketState: 'REGULAR',
      fiftyTwoWeekLow: q.l,
      fiftyTwoWeekHigh: q.h,
    };
    cache[ticker] = { ts: now, data: result };
    return result;
  } catch(e) { console.warn(`Finnhub ${ticker}:`, e.message); return null; }
}

// Batch — מקבילי עם delay קטן (60 בקשות/דקה = 1 שניה בין בקשות)
async function fetchBatch(tickers) {
  const results = [];
  for (let i = 0; i < tickers.length; i++) {
    // בדוק cache קודם
    const now = Date.now();
    if (cache[tickers[i]] && now - cache[tickers[i]].ts < CACHE_TTL) {
      results.push(cache[tickers[i]].data);
      continue;
    }
    const r = await fetchFinnhub(tickers[i]);
    if (r) results.push(r);
    // delay רק אם לא מה-cache (60 req/min = 1 per sec)
    if (i < tickers.length - 1) await new Promise(r => setTimeout(r, 1100));
  }
  return results;
}

// Yahoo Finance chart (לגרפים — ה-chart endpoint עובד בלי crumb)
async function fetchChart(ticker, from, to, interval) {
  try {
    const body = await get('query1.finance.yahoo.com',
      `/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${to}&interval=${interval}&events=div%2Csplit`
    );
    const data = JSON.parse(body);
    return data?.chart?.result || [];
  } catch(e) {
    console.error('Chart error:', e.message);
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), cached: Object.keys(cache).length, finnhub: FINNHUB_KEY ? 'set' : 'missing' }));
    return;
  }

  if (url.pathname === '/quote') {
    const symbols = url.searchParams.get('symbols');
    if (!symbols) { res.writeHead(400); res.end(JSON.stringify({ results: [] })); return; }
    const tickers = symbols.split(',').filter(Boolean).slice(0, 50);
    console.log('Quote:', tickers.length, 'tickers, cached:', tickers.filter(t => cache[t] && Date.now()-cache[t].ts < CACHE_TTL).length);
    try {
      const results = await fetchBatch(tickers);
      console.log('Results:', results.length);
      res.writeHead(200);
      res.end(JSON.stringify({ results }));
    } catch(e) {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [], error: e.message }));
    }
    return;
  }

  if (url.pathname === '/chart') {
    const ticker = url.searchParams.get('ticker');
    const from = url.searchParams.get('from') || '1';
    const to = url.searchParams.get('to') || String(Math.floor(Date.now()/1000));
    const interval = url.searchParams.get('interval') || '1d';
    console.log('Chart:', ticker, interval);
    const result = await fetchChart(ticker, from, to, interval);
    res.writeHead(200);
    res.end(JSON.stringify({ result }));
    return;
  }

  if (url.pathname === '/explain') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticker, name, lev, sectorName, price } = JSON.parse(body);
        const prompt = `כתוב הסבר מפורט ומעמיק בעברית על קרן ה-ETF הממונפת ${ticker} (${name}). המינוף: ${lev}. סקטור: ${sectorName}. מחיר: $${price||'—'}. כלול: 1) מה הקרן עושה 2) אחרי מה עוקבת 3) איך עובד המינוף עם דוגמאות מספריות 4) Volatility Decay 5) למי מתאים 6) סיכונים ספציפיים. עם כותרות מודגשות בעברית.`;
        const claudeBody = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
        const claudeRes = await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(claudeBody), 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_API_KEY || '' }
          }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d)); });
          r.on('error', reject); r.write(claudeBody); r.end();
        });
        const parsed = JSON.parse(claudeRes);
        const text = parsed.content?.[0]?.text || 'לא ניתן לייצר הסבר.';
        res.writeHead(200); res.end(JSON.stringify({ text }));
      } catch(e) {
        res.writeHead(200); res.end(JSON.stringify({ text: 'שגיאה: ' + e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`AZENO Server on port ${PORT} | Finnhub: ${FINNHUB_KEY ? 'SET' : 'MISSING'}`));

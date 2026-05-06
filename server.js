const https = require('https');
const http = require('http');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const cache = {};
const CACHE_TTL = 4 * 60 * 1000;

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        ...headers
      },
      maxHeaderSize: 81920
    }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// שלוף מחיר בודד דרך chart endpoint — לא דורש crumb
async function fetchSingle(ticker) {
  const now = Date.now();
  if (cache[ticker] && now - cache[ticker].ts < CACHE_TTL) {
    return cache[ticker].data;
  }
  try {
    const r = await httpsGet('query1.finance.yahoo.com',
      `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d&includePrePost=false`
    );
    const data = JSON.parse(r.body);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;

    const result = {
      symbol: ticker,
      regularMarketPrice: meta.regularMarketPrice,
      regularMarketChangePercent: meta.regularMarketPrice && meta.chartPreviousClose
        ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100)
        : 0,
      regularMarketVolume: meta.regularMarketVolume || 0,
      shortName: meta.longName || meta.shortName || ticker,
      marketState: meta.marketState || 'CLOSED',
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow || meta.regularMarketDayLow,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || meta.regularMarketDayHigh,
    };
    cache[ticker] = { ts: now, data: result };
    return result;
  } catch(e) {
    console.warn(`fetchSingle ${ticker}:`, e.message);
    return null;
  }
}

// שלוף batch של טיקרים
async function fetchBatch(tickers) {
  // נסה קודם את ה-batch endpoint של Yahoo
  try {
    const symbols = tickers.join(',');
    const r = await httpsGet('query1.finance.yahoo.com',
      `/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,fiftyTwoWeekLow,fiftyTwoWeekHigh,shortName,marketState&formatted=false&lang=en-US&region=US`
    );
    const data = JSON.parse(r.body);
    const results = data?.quoteResponse?.result || [];
    if (results.length > 0) {
      results.forEach(q => { cache[q.symbol] = { ts: Date.now(), data: q }; });
      console.log(`Batch OK: ${results.length}/${tickers.length}`);
      return results;
    }
  } catch(e) { console.warn('Batch failed:', e.message); }

  // Fallback: שלוף אחד אחד עם delay קטן
  console.log('Falling back to single fetch for', tickers.length, 'tickers');
  const results = [];
  for (let i = 0; i < tickers.length; i++) {
    const r = await fetchSingle(tickers[i]);
    if (r) results.push(r);
    if (i < tickers.length - 1) await new Promise(r => setTimeout(r, 120));
  }
  return results;
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
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), cached: Object.keys(cache).length }));
    return;
  }

  if (url.pathname === '/quote') {
    const symbols = url.searchParams.get('symbols');
    if (!symbols) { res.writeHead(400); res.end(JSON.stringify({ results: [] })); return; }
    const tickers = symbols.split(',').filter(Boolean).slice(0, 50);
    console.log('Quote:', tickers.length, 'tickers');
    try {
      const results = await fetchBatch(tickers);
      console.log('Results:', results.length);
      res.writeHead(200);
      res.end(JSON.stringify({ results }));
    } catch(e) {
      console.error('Quote error:', e.message);
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
    try {
      const r = await httpsGet('query1.finance.yahoo.com',
        `/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${from}&period2=${to}&interval=${interval}`
      );
      const data = JSON.parse(r.body);
      const result = data?.chart?.result || [];
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
    } catch(e) {
      console.error('Chart error:', e.message);
      res.writeHead(200);
      res.end(JSON.stringify({ result: [], error: e.message }));
    }
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

server.listen(PORT, () => console.log(`AZENO Server on port ${PORT}`));

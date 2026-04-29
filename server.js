const https = require('https');
const http = require('http');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
let cookie = '';
let crumb = '';

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers, maxHeaderSize: 81920 },
      (res) => {
        const chunks = [];
        let stream = res;
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers
        }));
        stream.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function refreshCrumb() {
  try {
    // Step 1: consent page to get cookie
    const r1 = await get('consent.yahoo.com', '/v2/collectConsent?sessionId=1', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
    });
    const cookies1 = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    // Step 2: finance.yahoo.com home
    const r2 = await get('finance.yahoo.com', '/', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cookie': cookies1,
    });
    const cookies2 = [...(r1.headers['set-cookie'] || []), ...(r2.headers['set-cookie'] || [])]
      .map(c => c.split(';')[0]).join('; ');
    cookie = cookies2;

    // Step 3: get crumb
    const r3 = await get('query1.finance.yahoo.com', '/v1/test/getcrumb', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://finance.yahoo.com/',
      'Cookie': cookie,
    });
    crumb = r3.body.trim();
    console.log('Crumb refreshed:', crumb, '| Cookie length:', cookie.length);
    return crumb.length > 0;
  } catch(e) {
    console.error('refreshCrumb error:', e.message);
    return false;
  }
}

async function fetchQuote(symbols) {
  if (!crumb) await refreshCrumb();
  const fields = 'regularMarketPrice,regularMarketChangePercent,regularMarketVolume,fiftyTwoWeekLow,fiftyTwoWeekHigh,shortName,marketState';
  const path = `/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=${fields}&crumb=${encodeURIComponent(crumb)}&formatted=false&lang=en-US&region=US`;
  const r = await get('query1.finance.yahoo.com', path, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://finance.yahoo.com/',
    'Cookie': cookie,
  });
  const data = JSON.parse(r.body);
  if (data?.quoteResponse?.error?.code === 'Unauthorized') {
    console.log('Unauthorized, refreshing crumb...');
    await refreshCrumb();
    return fetchQuote(symbols);
  }
  return data?.quoteResponse?.result || [];
}

async function fetchChart(ticker, from, to, interval) {
  if (!crumb) await refreshCrumb();
  const path = `/v8/finance/chart/${ticker}?period1=${from}&period2=${to}&interval=${interval}&crumb=${encodeURIComponent(crumb)}`;
  const r = await get('query1.finance.yahoo.com', path, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://finance.yahoo.com/',
    'Cookie': cookie,
  });
  const data = JSON.parse(r.body);
  return data?.chart?.result || [];
}

// Refresh crumb every 30 minutes
setInterval(refreshCrumb, 30 * 60 * 1000);
refreshCrumb(); // on startup

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), crumb: crumb || 'none' }));
    return;
  }

  if (url.pathname === '/quote') {
    const symbols = url.searchParams.get('symbols');
    if (!symbols) { res.writeHead(400); res.end(JSON.stringify({ results: [] })); return; }
    try {
      const results = await fetchQuote(symbols);
      console.log('Quote:', symbols.split(',').length, 'symbols ->', results.length, 'results');
      res.writeHead(200);
      res.end(JSON.stringify({ results }));
    } catch(e) {
      console.error('Quote error:', e.message);
      crumb = ''; cookie = '';
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
      const result = await fetchChart(ticker, from, to, interval);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
    } catch(e) {
      console.error('Chart error:', e.message);
      crumb = ''; cookie = '';
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
        const prompt = `כתוב הסבר מפורט ומעמיק בעברית על קרן ה-ETF הממונפת ${ticker} (${name}). המינוף: ${lev}. סקטור: ${sectorName}. מחיר: $${price||'—'}.
כלול: 1) מה הקרן עושה 2) אחרי מה עוקבת 3) איך עובד המינוף עם דוגמאות מספריות 4) Volatility Decay 5) למי מתאים 6) סיכונים ספציפיים. עם כותרות מודגשות בעברית.`;
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

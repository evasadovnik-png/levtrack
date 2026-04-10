const https = require('https');
const http = require('http');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
let cachedCrumb = null;
let cachedCookie = null;

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ 
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
        status: res.statusCode
      }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function getCrumb() {
  if (cachedCrumb && cachedCookie) return { crumb: cachedCrumb, cookie: cachedCookie };
  
  // שלב 1: קבל cookie
  const r1 = await httpsGet('finance.yahoo.com', '/', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
  });
  
  const cookies = r1.headers['set-cookie'] || [];
  const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
  
  // שלב 2: קבל crumb
  const r2 = await httpsGet('query1.finance.yahoo.com', '/v1/test/getcrumb', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://finance.yahoo.com/',
    'Cookie': cookieStr,
  });
  
  cachedCrumb = r2.body.trim();
  cachedCookie = cookieStr;
  console.log('Got crumb:', cachedCrumb, 'cookie length:', cookieStr.length);
  return { crumb: cachedCrumb, cookie: cachedCookie };
}

async function fetchPrices(tickers) {
  const { crumb, cookie } = await getCrumb();
  const symbols = tickers.join(',');
  const fields = 'regularMarketPrice,regularMarketChangePercent,regularMarketVolume,fiftyTwoWeekLow,fiftyTwoWeekHigh,shortName,marketState';
  const path = `/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=${fields}&crumb=${encodeURIComponent(crumb)}&formatted=false&lang=en-US&region=US`;
  
  const r = await httpsGet('query1.finance.yahoo.com', path, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://finance.yahoo.com/',
    'Cookie': cookie,
  });
  
  const data = JSON.parse(r.body);
  return data?.quoteResponse?.result || [];
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), crumb: cachedCrumb ? 'cached' : 'none' }));
    return;
  }

  if (url.pathname === '/quote') {
    const symbols = url.searchParams.get('symbols');
    if (!symbols) { res.writeHead(400); res.end(JSON.stringify({ results: [], error: 'symbols required' })); return; }
    const tickers = symbols.split(',').filter(Boolean).slice(0, 50);
    console.log('Fetching:', tickers.length, 'tickers:', tickers.slice(0,3).join(','),'...');
    try {
      const results = await fetchPrices(tickers);
      console.log('Success:', results.length, 'results');
      res.writeHead(200);
      res.end(JSON.stringify({ results }));
    } catch(e) {
      console.error('Error:', e.message);
      // נסה לאפס את ה-crumb ולנסות שוב
      cachedCrumb = null; cachedCookie = null;
      try {
        const results = await fetchPrices(tickers);
        res.writeHead(200);
        res.end(JSON.stringify({ results }));
      } catch(e2) {
        res.writeHead(200);
        res.end(JSON.stringify({ results: [], error: e2.message }));
      }
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`LevTrack Server on port ${PORT}`));

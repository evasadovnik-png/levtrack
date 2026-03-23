const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3000;

function fetchYahoo(tickers) {
  return new Promise((resolve, reject) => {
    const symbols = tickers.join(',');
    const fields = 'regularMarketPrice,regularMarketChangePercent,regularMarketVolume,fiftyTwoWeekLow,fiftyTwoWeekHigh,shortName,marketState';
    const path = `/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=${fields}`;
    
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('Parse error'));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  if (url.pathname === '/quote') {
    const symbols = url.searchParams.get('symbols');
    if (!symbols) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'symbols required' }));
      return;
    }

    try {
      const tickers = symbols.split(',').slice(0, 50); // מקסימום 50 בבקשה
      const data = await fetchYahoo(tickers);
      const results = data?.quoteResponse?.result || [];
      
      res.writeHead(200);
      res.end(JSON.stringify({ results }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message, results: [] }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`LevTrack Server running on port ${PORT}`);
});

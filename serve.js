// Link Gen Tool — tiny local static server
// Serves link-gen-tool.js (and any other file in this folder) on
// http://localhost:PORT so the bookmarklet can load it instantly during
// local development (mirrors the timeline-qa-tool local-dev pattern).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8844;
const ROOT = __dirname;

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const pathname = req.url.split('?')[0];
  const file = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT, file);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + file);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Link Gen Tool server listening on http://localhost:${PORT}/link-gen-tool.js`);
});

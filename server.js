import http from 'node:http';
import { createAutoChallenge, validateTargets } from './auto-challenge.js';
import { createProtection } from './protection.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function createApp({ token = process.env.CF_API_TOKEN, zone = process.env.CF_ZONE_ID, fetcher = fetch, key = process.env.CF_API_KEY, email = process.env.CF_API_EMAIL, protection, autoChallenge } = {}) {
  const buckets = new Map();
  const json = (req, res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
  };
  function recordRequest() {
    const second = Math.floor(Date.now() / 1000) * 1000;
    buckets.set(second, (buckets.get(second) || 0) + 1);
    for (const time of buckets.keys()) if (time < second - 300000) buckets.delete(time);
  }
  return http.createServer(async (req, res) => {
    let requestUrl;
    try { requestUrl = new URL(req.url, 'http://localhost'); }
    catch { req.resume(); return json(req, res, 400, { error: 'Invalid request URL' }); }
    const path = requestUrl.pathname;
    const internalDashboardRequest = req.headers['x-dstat-internal'] === '1';
    if (!internalDashboardRequest) recordRequest();
    try {
      if (path === '/api/auto-challenge') {
        if (!autoChallenge) return json(req, res, 503, { error: 'Auto challenge unavailable' });
        if (['GET', 'HEAD'].includes(req.method)) return json(req, res, 200, autoChallenge.status());
        if (req.method !== 'POST') return json(req, res, 405, { error: 'Method not allowed' });
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const host = req.headers.host || '';
        if (!local || !/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host) || req.headers.origin !== `http://${host}` || req.headers['x-dstat-settings'] !== '1' || req.headers['content-type'] !== 'application/json' || req.headers['x-forwarded-for'] || req.headers.forwarded) {
          req.resume(); return json(req, res, 403, { error: 'เปลี่ยนการตั้งค่าจาก dashboard บน localhost เท่านั้น' });
        }
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) return json(req, res, 413, { error: 'Body too large' }); }
        let input; try { input = JSON.parse(body); } catch { return json(req, res, 400, { error: 'Invalid JSON' }); }
        if (typeof input?.enabled !== 'boolean') return json(req, res, 400, { error: 'enabled must be boolean' });
        if (input.targets !== undefined) {
          try { input.targets = validateTargets(input.targets); } catch (e) { return json(req, res, 400, { error: e.message }); }
        }
        return json(req, res, 200, await autoChallenge.configure(input.targets === undefined && input.ruleId === undefined ? input.enabled : input));
      }
      if (path === '/probe') {
        req.resume(); return json(req, res, 200, { ok: true, counted: !internalDashboardRequest });
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        req.resume(); return json(req, res, 200, { ok: true, counted: !internalDashboardRequest, method: req.method, path });
      }
      if (path === '/api/protection-traffic') return json(req, res, protection ? 200 : 503, protection ? await protection.traffic() : { error: 'Protection worker unavailable' });
      if (path === '/api/protection') return json(req, res, 200, protection?.status(Object.fromEntries(requestUrl.searchParams)) || { enabled: false });
      if (path === '/api/local') {
        const end = Math.floor(Date.now() / 1000) * 1000;
        const points = Array.from({ length: 60 }, (_, i) => { const time = end - (60 - i) * 1000; const requests = buckets.get(time) || 0; return { time, requests, rps: requests }; });
        return json(req, res, 200, { source: 'local', interval: 1, fetchedAt: Date.now(), points });
      }

      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (!files[path]) {
        req.resume(); return json(req, res, 200, { ok: true, counted: !internalDashboardRequest, method: req.method, path });
      }
      const [file, mime] = files[path];
      const body = await readFile(new URL(`./public/${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store, max-age=0' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) { json(req, res, 502, { error: error.name === 'TimeoutError' ? 'Cloudflare ใช้เวลาตอบกลับนานเกินไป' : error.message }); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 3348);
  const protection = createProtection();
  const autoChallenge = createAutoChallenge();
  const server = createApp({ protection, autoChallenge });
  server.once('listening', () => { protection.start(); autoChallenge.start(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await Promise.all([protection.stop(), autoChallenge.stop()]); server.close(() => process.exit(0)); server.closeAllConnections(); });
  server.listen({ port, host, backlog: 8192 }, () => console.log(`protection-system ready → http://${host}:${port}`));
}

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { createProtectionTraffic } from './protection-traffic.js';
import { createBanManager } from './bans.js';
import { createCloudflare } from './cloudflare.js';

export function protectionConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`ค่า ${name} ต้องเป็นจำนวนเต็ม ${min}–${max}`);
    return value;
  };
  const allowlist = (env.CF_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowlist.some(ip => !isIP(ip))) throw new Error('CF_ALLOW_IPS ต้องเป็น IP คั่นด้วย comma');
  return { enabled: env.CF_PROTECTION_ENABLED === 'true', dryRun: env.CF_PROTECTION_DRY_RUN !== 'false',
    ddosEvidence: env.CF_DDOS_EVIDENCE !== 'false',
    zone: env.CF_ZONE_ID, account: env.CF_ACCOUNT_ID, listName: env.CF_LIST_NAME || 'black',
    threshold: number('CF_REQUESTS_PER_MINUTE', 300, 1, 1000000000),
    minutes: number('CF_CONSECUTIVE_MINUTES', 1, 1, 10),
    lag: number('CF_ANALYTICS_LAG_MINUTES', 0, 0, 10),
    maxAdds: number('CF_MAX_ADDS_PER_CYCLE', 100, 1, 100), capacity: number('CF_BAN_CAPACITY', 49000, 1, 49000), allowlist };
}
const canonical = ip => isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
export function createProtection({ config = protectionConfig(), api = createCloudflare(), now = Date.now, manager, queueFile = 'data/ban-queue.json' } = {}) {
  const bans = manager || createBanManager({ api, zone: config.zone, account: config.account, capacity: config.capacity, now });
  const state = { enabled: config.enabled, dryRun: config.dryRun, backend: 'ip-access-rules', threshold: config.threshold,
    consecutiveMinutes: config.minutes, lastCheck: null, lastSuccess: null, error: null, candidates: [], added: 0, operation: null };
  const allowed = new Set(config.allowlist.map(canonical));
  let pending, timer, stopped = false, lastScan, lastSync, retryAt = 0, loaded = false;
  const queue = new Map();
  let hotIPs = new Set(), checkedIPs = new Set();
  const traffic = createProtectionTraffic({ api, zone: config.zone, now, classification: () => ({
    banned: bans.blockedIPs(), queued: new Set(queue.keys()), checked: new Set(checkedIPs), checkedAt: state.lastDetection, syncedAt: bans.syncedAt()
  }) });
  async function saveQueue() {
    if (!queueFile) return;
    await mkdir(dirname(queueFile), { recursive: true });
    await writeFile(queueFile + '.tmp', JSON.stringify([...queue.values()]), { mode: 0o600 });
    await rename(queueFile + '.tmp', queueFile);
  }

  async function cycle() {
    if (now() < retryAt) return;
    state.lastCheck = now();
    if (!config.zone || !config.account) throw new Error('ต้องตั้งค่า CF_ZONE_ID และ CF_ACCOUNT_ID');
    if (!loaded) {
      if (queueFile) { try { for (const item of JSON.parse(await readFile(queueFile, 'utf8'))) if (isIP(item.ip)) queue.set(canonical(item.ip), item); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      loaded = true;
    }
    if (lastSync === undefined || now() - lastSync >= 60000) { await bans.sync(); lastSync = now(); }
    if (lastScan === undefined || now() - lastScan >= 15000) {
    const end = (config.minutes === 1 ? now() : Math.floor(now() / 60000) * 60000) - config.lag * 60000;
    // Separate bounded queries guarantee a complete-minute count for each candidate.
    const totals = new Map(), observed = new Set();
    for (let i = 0; i < (config.minutes === 1 ? 3 : config.minutes); i++) {
      const data = await api('/graphql', { method: 'POST', body: {
        query: `query Protection($zone: string, $start: Time, $end: Time) { viewer { zones(filter: {zoneTag: $zone}) { httpRequestsAdaptiveGroups(limit: 10000, orderBy: [count_DESC], filter: {datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball"}) { count dimensions { clientIP } } } } }`,
        variables: { zone: config.zone, start: new Date(end - (i + 1) * 60000).toISOString(), end: new Date(end - i * 60000).toISOString() }
      } });
      const rows = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
      if (!Array.isArray(rows)) throw new Error('Cloudflare ไม่ส่งข้อมูล IP: ตรวจสิทธิ์ Analytics');
      const seen = new Set();
      for (const row of rows) {
        const ip = row.dimensions?.clientIP;
        if (isIP(ip || '')) observed.add(canonical(ip));
        if (!isIP(ip || '') || !Number.isFinite(row.count) || row.count <= config.threshold) continue;
        const normalized = canonical(ip);
        if (allowed.has(normalized) || seen.has(normalized)) continue;
        seen.add(normalized);
        const item = totals.get(normalized) || { ip: normalized, minutes: 0, minRequests: row.count };
        item.minutes++; item.minRequests = Math.min(item.minRequests, row.count); totals.set(normalized, item);
      }
    }
    checkedIPs = observed;
    hotIPs = new Set(totals.keys());
    const eligible = [...totals.values()].filter(x => x.minutes >= config.minutes && !bans.has(x.ip));
    state.eligible = eligible.length; state.lastDetection = now();
    for (const item of eligible) queue.set(item.ip, { ...item, detectedAt: now() });
    if (config.ddosEvidence) {
      try {
        const data = await api('/graphql', { method: 'POST', body: {
          query: `query Suspects($zone:string,$start:Time){viewer{zones(filter:{zoneTag:$zone}){firewallEventsAdaptive(limit:10000,orderBy:[datetime_DESC],filter:{datetime_geq:$start,action:"block",source:"l7ddos"}){clientIP datetime}}}}`,
          variables: { zone: config.zone, start: new Date(now() - 180000).toISOString() }
        } });
        const events = data.data?.viewer?.zones?.[0]?.firewallEventsAdaptive;
        if (!Array.isArray(events)) throw new Error('ไม่พบข้อมูล DDoS events');
        const counts = new Map();
        for (const event of events) if (isIP(event.clientIP || '')) {
          const ip = canonical(event.clientIP); counts.set(ip, (counts.get(ip) || 0) + 1);
        }
        state.ddosCandidates = 0; state.ddosSampleLimit = events.length === 10000;
        for (const [ip, eventCount] of counts) if (eventCount >= 3 && !allowed.has(ip)) {
          hotIPs.add(ip);
          if (!bans.has(ip)) { queue.set(ip, { ip, minRequests: 0, reason: 'ddos', eventCount, detectedAt: now() }); state.ddosCandidates++; }
        }
        state.evidenceError = null;
      } catch (error) { state.evidenceError = error.message; if (error.retryAt) throw error; }
    }
    for (const [ip, item] of queue) if (bans.has(ip) || allowed.has(ip)) queue.delete(ip);
    lastScan = now();
    }
    state.candidates = [...queue.values()].sort((a,b) => Number(b.reason === 'ddos') - Number(a.reason === 'ddos') || (b.eventCount || b.minRequests) - (a.eventCount || a.minRequests)).slice(0, Math.min(3, config.maxAdds));
    await saveQueue(); // Keep overflow and failed writes for following cycles/restarts.
    if (!config.dryRun && state.candidates.length && !stopped) {
      const protectedIPs = new Set([...hotIPs, ...queue.keys()]);
      if (bans.banBatch) {
        const results = await bans.banBatch(state.candidates, protectedIPs);
        for (const result of results) if (!result.error) { state.added++; queue.delete(result.ip); }
        await saveQueue();
        const failure = results.find(result => result.error); if (failure) throw failure.error;
      } else {
        for (const candidate of state.candidates) {
          if (stopped) break;
          if (await bans.ban(candidate, protectedIPs)) state.added++;
          queue.delete(candidate.ip); await saveQueue();
        }
      }
    }

    state.lastSuccess = now();
  }
  function tick() {
    if (!config.enabled || stopped) return Promise.resolve();
    if (pending) return pending;
    pending = cycle().then(() => { state.error = null; }).catch(error => { state.error = error.message; retryAt = error.retryAt || now() + 15000; state.retryAt = retryAt; lastSync = undefined; }).finally(() => { pending = null; });
    return pending;
  }
  return { traffic: () => traffic.read(), tick, status: (query) => structuredClone({ ...state, queued: queue.size, scanSeconds: 15, parallelBans: 3, retryAt, maxAdds: config.maxAdds, lagMinutes: config.lag, ...bans.snapshot(query) }), start() {
    if (timer || !config.enabled) return;
    stopped = false; void tick(); timer = setInterval(() => void tick(), 1000); timer.unref();
  }, async stop() { stopped = true; clearInterval(timer); timer = null; await pending; } };
}

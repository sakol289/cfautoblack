import { isIP } from 'node:net';
import { normalizeIP } from './bans.js';
export function summarizeTraffic(rows, snapshot) {
  const groups = Object.fromEntries(['banned', 'queued', 'checked', 'unassessed'].map(key => [key, { requests: 0, ips: 0 }]));
  const counts = new Map();
  for (const row of rows) {
    const ip = row.dimensions?.clientIP;
    if (!isIP(ip || '') || !Number.isFinite(row.count) || row.count < 0) throw new Error('Cloudflare ส่งข้อมูล IP/count ไม่สมบูรณ์');
    const key = normalizeIP(ip); counts.set(key, (counts.get(key) || 0) + row.count);
  }
  for (const [ip, count] of counts) {
    const key = snapshot.banned.has(ip) ? 'banned' : snapshot.queued.has(ip) ? 'queued' : snapshot.checked.has(ip) ? 'checked' : 'unassessed';
    groups[key].requests += count; groups[key].ips++;
  }
  return groups;
}
export function createProtectionTraffic({ api, zone, classification, now = Date.now }) {
  let pending, fetched = 0, attempted = 0, error = null;
  const points = [];
  async function collect() {
    const end = now(), snapshot = classification();
    if (!snapshot.checkedAt || !snapshot.syncedAt) throw new Error('รอ worker ตรวจ IP และ sync รายการแบนก่อน');
    const d = await api('/graphql', { method: 'POST', body: {
      query: `query ProtectionTraffic($zone:string,$start:Time,$end:Time){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:10000,orderBy:[count_DESC],filter:{datetime_geq:$start,datetime_lt:$end,requestSource:"eyeball"}){count dimensions{clientIP}}}}}`,
      variables: { zone, start: new Date(end - 60000).toISOString(), end: new Date(end).toISOString() }
    } });
    const rows = d.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
    if (!Array.isArray(rows)) throw new Error('ไม่พบ Analytics สำหรับกราฟแยกสถานะ');
    const groups = summarizeTraffic(rows, snapshot);
    points.push({ time: end, groups, limited: rows.length === 10000, checkedAt: snapshot.checkedAt, syncedAt: snapshot.syncedAt });
    while (points.length > 60) points.shift();
    fetched = now(); error = null;
  }
  return { async read() {
    if (!pending && (!attempted || now() - attempted >= 30000)) {
      attempted = now(); pending = collect().catch(e => { error = e.message; }).finally(() => { pending = null; });
    }
    if (pending) await pending;
    return { source: 'cloudflare', windowSeconds: 60, refreshSeconds: 30, fetchedAt: fetched || null, error,
      stale: !!error || !fetched || now() - fetched > 90000, points: structuredClone(points) };
  } };
}

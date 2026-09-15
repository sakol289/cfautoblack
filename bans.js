import { isIP } from 'node:net';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
export const normalizeIP = ip => isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
export function createBanManager({ api, zone, account, capacity = 49000, now = Date.now, historyFile = 'data/ban-events.json' }) {
  const root = `/zones/${zone}/firewall/access_rules/rules`;
  const prefix = `dstat:v2:${zone}:`;
  let ruleIPs = new Set();
  let rules = [], events = [], syncedAt = null, quota = null, loaded = false;
  async function event(type, ip, detail) {
    events.unshift({ time: now(), type, ip, detail }); events = events.slice(0, 200);
    if (historyFile) {
      await mkdir(dirname(historyFile), { recursive: true });
      await writeFile(`${historyFile}.tmp`, JSON.stringify(events), { mode: 0o600 });
      await rename(`${historyFile}.tmp`, historyFile);
    }
  }
  async function sync() {
    if (!loaded) {
      if (historyFile) { try { events = JSON.parse(await readFile(historyFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      loaded = true;
    }
    const all = []; let page = 1, pages;
    do {
      const d = await api(`${root}?per_page=1000&page=${page}`);
      if (!Array.isArray(d.result) || !Number.isInteger(d.result_info?.total_pages)) throw new Error('Cloudflare ส่งข้อมูลกฎไม่ครบ');
      all.push(...d.result); pages = d.result_info.total_pages; page++;
    } while (page <= pages);
    rules = all; ruleIPs = new Set(all.map(r => normalizeIP(r.configuration?.value))); syncedAt = now();
    if (!quota || now() - quota.checkedAt > 300000) await refreshQuota();
  }
  // Include account-level and every zone's rules. Inherited rules can make this
  // conservative (overcount), so never present this as an exact CF quota counter.
  async function refreshQuota() {
    const count = async path => {
      const d = await api(`${path}?per_page=1`);
      if (!Number.isInteger(d.result_info?.total_count)) throw new Error('อ่านโควตา Cloudflare ไม่สำเร็จ');
      return d.result_info.total_count;
    };
    let total = await count(`/accounts/${account}/firewall/access_rules/rules`);
    let page = 1, pages;
    do {
      const d = await api(`/zones?account.id=${account}&per_page=50&page=${page}`);
      if (!Array.isArray(d.result) || !Number.isInteger(d.result_info?.total_pages)) throw new Error('อ่าน zones สำหรับโควตาไม่สำเร็จ');
      for (let i = 0; i < d.result.length; i += 5) {
        const counts = await Promise.all(d.result.slice(i, i + 5).map(z => count(`/zones/${z.id}/firewall/access_rules/rules`)));
        total += counts.reduce((sum, n) => sum + n, 0);
      }
      pages = d.result_info.total_pages; page++;
    } while (page <= pages);
    quota = { used: total, checkedAt: now(), limit: 50000, capacity, conservative: true };
  }
  const owned = r => r.mode === 'block' && r.notes?.startsWith(prefix) && r.scope?.type === 'zone' && r.scope.id === zone;
  const has = ip => ruleIPs.has(normalizeIP(ip));
  async function ban(candidate, protectedIPs = new Set(), { force = false } = {}) {
    const ip = normalizeIP(candidate.ip);
    if (!isIP(ip)) throw new Error('IP ไม่ถูกต้อง');
    if (has(ip)) return false; // Preserve existing allow/challenge/block choices.
    if (!quota || now() - quota.checkedAt > 300000) await refreshQuota();
    if (quota.used >= capacity) {
      if (now() - quota.checkedAt > 60000) await refreshQuota();
      if (quota.used >= capacity) {
        const victims = rules.filter(r => owned(r) && !protectedIPs.has(normalizeIP(r.configuration.value)) && Number.isFinite(Date.parse(r.created_on)))
          .sort((a,b) => Date.parse(a.created_on) - Date.parse(b.created_on));
        if (!victims.length || force) throw new Error('ใกล้เต็มและไม่มีแบนเก่าของ dstat ที่ปลดได้');
        // One replacement at a time. Do not mass-delete when other users fill the account.
        const victim = victims[0];
        const current = (await api(`${root}/${victim.id}`)).result;
        if (!current || !owned(current) || current.configuration.value !== victim.configuration.value) throw new Error('กฎที่จะปลดถูกแก้ไข: หยุดและรอ sync');
        await api(`${root}/${victim.id}`, { method: 'DELETE' });
        rules = rules.filter(r => r.id !== victim.id); ruleIPs = new Set(rules.map(r => normalizeIP(r.configuration?.value))); quota.used--;
        await event('unban', victim.configuration.value, 'ปลดแบนเก่าสุดเพื่อสำรองที่ว่าง');
      }
    }
    const d = await api(root, { method: 'POST', body: { mode: 'block', configuration: { target: isIP(ip) === 6 ? 'ip6' : 'ip', value: ip }, notes: `${prefix}${candidate.reason || 'rate'}:${candidate.eventCount || candidate.minRequests || 0}` } });
    if (!d.result?.id) throw new Error('Cloudflare ไม่ส่ง rule id');
    rules.push(d.result); ruleIPs.add(normalizeIP(d.result.configuration.value)); quota.used++;
    await event('ban', ip, candidate.reason === 'legacy' ? 'ย้ายจาก black เดิม' : candidate.reason === 'ddos' ? `Cloudflare DDoS Block ${candidate.eventCount} เหตุการณ์/3 นาที` : `เกินเกณฑ์ ${candidate.minRequests} req/min`);
    return true;
  }
  async function banBatch(candidates, protectedIPs) {
    if (!quota || now() - quota.checkedAt > 300000) await refreshQuota();
    const batch = candidates.filter(c => !has(c.ip));
    // Near capacity, preserve the existing serialized eviction path.
    if (quota.used + batch.length >= capacity) {
      const result = [];
      for (const candidate of batch) { try { await ban(candidate, protectedIPs); result.push({ ip: candidate.ip }); } catch (error) { result.push({ ip: candidate.ip, error }); break; } }
      return result;
    }
    const outcomes = await Promise.allSettled(batch.map(candidate => api(root, { method: 'POST', body: {
      mode: 'block', configuration: { target: isIP(candidate.ip) === 6 ? 'ip6' : 'ip', value: normalizeIP(candidate.ip) },
      notes: `${prefix}${candidate.reason || 'rate'}:${candidate.eventCount || candidate.minRequests}`
    } })));
    const results = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i], candidate = batch[i];
      if (outcome.status === 'rejected') { results.push({ ip: candidate.ip, error: outcome.reason }); continue; }
      if (!outcome.value.result?.id) { results.push({ ip: candidate.ip, error: new Error('Cloudflare ไม่ส่ง rule id') }); continue; }
      rules.push(outcome.value.result); ruleIPs.add(normalizeIP(outcome.value.result.configuration.value)); quota.used++;
      try { await event('ban', candidate.ip, candidate.reason === 'ddos' ? `Cloudflare DDoS Block ${candidate.eventCount} เหตุการณ์/3 นาที` : `เกินเกณฑ์ ${candidate.minRequests} req/60s`); results.push({ ip: candidate.ip }); }
      catch (error) { results.push({ ip: candidate.ip, error }); }
    }
    return results;
  }
  return { blockedIPs: () => new Set(rules.filter(r => r.mode === 'block').map(r => normalizeIP(r.configuration.value))), syncedAt: () => syncedAt, sync, refreshQuota, ban, banBatch, has, isBlocked: ip => rules.some(r => r.mode === 'block' && normalizeIP(r.configuration?.value) === normalizeIP(ip)), snapshot({ search = '', page = 1 } = {}) {
    const bans = rules.filter(r => r.mode === 'block');
    const filtered = bans.filter(r => r.configuration?.value?.includes(search)).sort((a,b) => Date.parse(b.created_on) - Date.parse(a.created_on));
    const pages = Math.max(1, Math.ceil(filtered.length / 50)); page = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    return { syncedAt, quota, active: bans.length, managed: bans.filter(owned).length, events,
      page, pages, matched: filtered.length,
      bans: filtered.slice((page - 1) * 50, page * 50).map(r => ({ id: r.id, ip: r.configuration.value, createdAt: r.created_on, managed: owned(r), reason: r.notes?.startsWith(prefix + 'ddos:') ? `Cloudflare DDoS ${r.notes.slice((prefix + 'ddos:').length)} เหตุการณ์` : r.notes?.startsWith(prefix + 'legacy:') ? 'ย้ายจากรายการแบนเดิม' : r.notes?.startsWith(prefix + 'rate:') ? `ทราฟฟิกสูง ${r.notes.slice((prefix + 'rate:').length)} req/min` : 'กฎภายนอก dstat' })) };
  } };
}

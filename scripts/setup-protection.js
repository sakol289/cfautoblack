// Migrate the old black list without disabling its rule until every item is covered.
import { createCloudflare } from '../cloudflare.js';
import { createBanManager } from '../bans.js';
import { protectionConfig } from '../protection.js';
const config = protectionConfig(), api = createCloudflare();
const manager = createBanManager({ api, ...config });
await manager.sync();
const lists = (await api(`/accounts/${config.account}/rules/lists`)).result;
const list = lists.find(l => l.name === config.listName && l.kind === 'ip');
if (list) {
  let cursor;
  do {
    const d = await api(`/accounts/${config.account}/rules/lists/${list.id}/items?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of d.result) {
      await manager.ban({ ip: item.ip, reason: 'legacy' }, new Set(), { force: true });
      if (!manager.isBlocked(item.ip)) throw new Error('รายการเดิมมี allow/challenge ที่ขัดกัน: ไม่ปิดกฎเดิม');
    }
    cursor = d.result_info?.cursors?.after;
  } while (cursor);
  const path = `/zones/${config.zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const ruleset = (await api(path)).result;
  // Only disable the exact rule created by this project, preserving the list itself.
  for (const rule of ruleset.rules || []) if (rule.description === 'dstat automatic IP blacklist' && rule.expression === `ip.src in $${config.listName}` && rule.action === 'block' && rule.enabled) {
    await api(`/zones/${config.zone}/rulesets/${ruleset.id}/rules/${rule.id}`, { method: 'PATCH', body: { action: rule.action, expression: rule.expression, description: rule.description, enabled: false } });
  }
}
await manager.sync(); console.log(JSON.stringify({ active: manager.snapshot().active, managed: manager.snapshot().managed, backend: 'ip-access-rules' }));

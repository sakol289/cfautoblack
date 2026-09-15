import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCloudflare } from './cloudflare.js';

const description = 'dstat automatic outage challenge';
const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length > 10) throw Error('ตั้งค่าได้ไม่เกิน 10 เว็บไซต์');
  const seen = new Set();
  const result = targets.map(t => {
    const hostname = typeof t?.hostname === 'string' ? t.hostname.toLowerCase().trim() : '';
    const healthPath = t?.healthPath || '/probe';
    if (!domainPattern.test(hostname) || seen.has(hostname)) throw Error('ชื่อเว็บไซต์ไม่ถูกต้องหรือซ้ำ');
    if (typeof healthPath !== 'string' || !/^\/[a-zA-Z0-9/_\-.]{1,150}$/.test(healthPath) || healthPath.includes('..') || healthPath.includes('//')) throw Error('Health path ต้องเป็น path เฉพาะ เช่น /probe หรือ /health');
    if (!['json', 'status'].includes(t.healthMode || 'json') || typeof t.enabled !== 'boolean') throw Error('การตั้งค่าเว็บไซต์ไม่ถูกต้อง');
    seen.add(hostname); return { hostname, healthPath, healthMode: t.healthMode || 'json', enabled: t.enabled };
  });
  if (result.reduce((n,t)=>n+t.hostname.length+t.healthPath.length+130,0)>4000) throw Error('รายการเว็บไซต์ยาวเกินขนาดกฎ กรุณาลดจำนวนหรือความยาว path');
  return result;
}
const fresh = config => ({ ...config, active: false, health: 'waiting', httpStatus: null, failures: 0, recovery: 0,
  requestsPerMinute: null, checkedAt: null, error: null, activeSince: 0 });
export function createAutoChallenge({ api = createCloudflare(), zone = process.env.CF_ZONE_ID, zoneName,
  hostname = process.env.CF_CHALLENGE_HOST || 'example.com', ruleId = process.env.CF_UAM_RULE_ID || '',
  enabled = process.env.CF_AUTO_CHALLENGE === 'true', file = 'data/auto-challenge.json', fetcher = fetch, now = Date.now } = {}) {
  let targets = validateTargets([{hostname, enabled:true, healthPath:'/probe', healthMode:'json'}]).map(fresh);
  if (ruleId && !/^[a-f0-9]{32}$/i.test(ruleId)) throw Error('CF_UAM_RULE_ID ต้องเป็น Rule ID 32 ตัว');
  let loaded = false, pending, timer, stopped = false, observed = [], accepted = [], backups = {};
  const state = { enabled, ruleId, active: null, zoneName: zoneName || null, checkedAt:null, error:null, events:[], quietThreshold:6000 };
  const entrypoint = `/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const legacy = `(http.host eq "${hostname}" and http.request.method in {"GET" "HEAD"} and http.request.uri.path eq "/")`;
  const expressionFor = rows => rows.length ? rows.map(t => `(http.host eq "${t.hostname}" and http.request.method in {"GET" "HEAD"} and http.request.uri.path ne "${t.healthPath}")`).join(' or ') : 'false';
  const config = () => targets.map(({hostname,healthPath,healthMode,enabled}) => ({hostname,healthPath,healthMode,enabled}));
  async function load() {
    if (loaded) return;
    if (file) try {
      const saved = JSON.parse(await readFile(file,'utf8'));
      if(typeof saved.enabled !== 'boolean') throw Error('Invalid auto-challenge settings');
      state.enabled=saved.enabled;
      if (typeof saved.ruleId === 'string') state.ruleId=saved.ruleId;
      backups=saved.backups || {};
      if(saved.targets) targets=validateTargets(saved.targets).map(fresh);
      state.events=Array.isArray(saved.events)?saved.events.slice(0,50):[];
      accepted=Array.isArray(saved.accepted)?saved.accepted:[];
    } catch(e) { if(e.code!=='ENOENT') throw e; }
    loaded=true;
  }
  async function save() {
    if(!file)return;
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file+'.tmp',JSON.stringify({enabled:state.enabled,targets:config(),ruleId:state.ruleId,backups,accepted,events:state.events}),{mode:0o600});
    await rename(file+'.tmp',file);
  }
  async function checkZone(rows) {
    if(!state.zoneName) state.zoneName=(await api(`/zones/${zone}`)).result?.name;
    if(!state.zoneName) throw Error('อ่านชื่อ Cloudflare zone ไม่สำเร็จ');
    if(rows.some(t=>t.hostname!==state.zoneName&&!t.hostname.endsWith('.'+state.zoneName))) throw Error(`เว็บไซต์ต้องอยู่ใน zone ${state.zoneName}`);
  }
  async function getRule() {
    const set=(await api(entrypoint)).result;
    if(!set?.id||!Array.isArray(set.rules))throw Error('ไม่พบ custom ruleset');
    const matches=set.rules.filter(r=>state.ruleId ? r.id===state.ruleId : r.description===description);if(matches.length>1)throw Error('พบกฎ auto challenge ซ้ำ');
    const rule=matches[0];
    if(state.ruleId&&!rule)throw Error('ไม่พบ Rule ID ใน custom ruleset ของ zone นี้');
    if(rule&&state.ruleId&&!backups[state.ruleId]){
      if(!['challenge','js_challenge','managed_challenge'].includes(rule.action))throw Error('Rule ID ต้องเป็นกฎ Challenge เท่านั้น');
      backups[state.ruleId]=structuredClone(rule);accepted=[rule.expression];await save();
    }
    if(rule && (!['challenge','js_challenge','managed_challenge'].includes(rule.action)||![legacy,...accepted].includes(rule.expression)))throw Error('กฎ auto challenge ถูกแก้ไขนอกระบบ');
    observed=rule&&rule.enabled!==false?[...rule.expression.matchAll(/http.host eq "([^"]+)"/g)].map(m=>m[1]):[];
    state.active=observed.length>0;
    for(const t of targets){t.active=observed.includes(t.hostname);if(t.active&&!t.activeSince)t.activeSince=now();if(!t.active)t.activeSince=0;}
    return {set,rule};
  }
  async function reconcile(wanted,current,reason) {
    const {set,rule}=current;const expression=expressionFor(wanted),active=wanted.length>0;
    if(!rule&&!active)return;
    if(rule&&rule.expression===expression&&(rule.enabled!==false)===active)return;
    // Persist both sides before an API write so an uncertain response is recoverable after restart.
    accepted=[...new Set([rule?.expression,expression].filter(Boolean))];await save();
    const body={description:rule?.description || description,expression,action:rule?.action || 'managed_challenge',enabled:active};
    const path=`/zones/${zone}/rulesets/${set.id}/rules`;
    await api(rule?`${path}/${rule.id}`:path,{method:rule?'PATCH':'POST',body:{...body,...(active&&set.rules[0]?.id!==rule?.id&&set.rules.length?{position:{before:set.rules[0].id}}:{})}});
    const verified=await getRule();
    if(verified.rule?.expression!==expression||state.active!==active)throw Error('Cloudflare ยังไม่ยืนยันสถานะ Challenge');
    accepted=[expression];state.events.unshift({time:now(),active,hosts:[...observed],reason});state.events=state.events.slice(0,50);await save();
  }
  async function health(t) {
    try {
      const r=await fetcher(`https://${t.hostname}${t.healthPath}?dstat_health=${now()}`,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'Cache-Control':'no-cache','X-Dstat-Internal':'1'}});
      t.httpStatus=r.status;
      if(r.status>=500){await r.body?.cancel();return 'down';}
      if(r.status===200&&t.healthMode==='json')return (await r.json().catch(()=>null))?.ok===true?'healthy':'unknown';
      await r.body?.cancel();return r.status===200?'healthy':'unknown';
    }catch{t.httpStatus=null;return 'down';}
  }
  async function traffic(t) {
    const end=Math.floor(now()/60000)*60000;
    const data=await api('/graphql',{method:'POST',body:{query:`query Recovery($zone:string,$start:Time,$end:Time,$host:string){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:2,filter:{datetime_geq:$start,datetime_lt:$end,clientRequestHTTPHost:$host,requestSource:"eyeball"}){count dimensions{datetimeMinute}}}}}`,variables:{zone,host:t.hostname,start:new Date(end-120000).toISOString(),end:new Date(end).toISOString()}}});
    const rows=data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
    if(!Array.isArray(rows)||rows.length!==2||rows.some(r=>!Number.isFinite(r.count)||r.count<0)||new Set(rows.map(r=>r.dimensions?.datetimeMinute)).size!==2)return null;
    return Math.max(...rows.map(r=>r.count));
  }
  async function cycle({settingsOnly=false}={}) {
    await load();await checkZone(targets);state.checkedAt=now();const current=await getRule();
    const wanted=[];
    // Independent health probes; Cloudflare mutations remain one serialized rule update.
    if(state.enabled&&!settingsOnly)await Promise.all(targets.filter(t=>t.enabled).map(async t=>{
      t.checkedAt=now();t.health=await health(t);t.failures=t.health==='down'?t.failures+1:0;
    }));
    for(const t of targets){
      if(!state.enabled||!t.enabled){t.failures=0;t.recovery=0;continue;}
      let keep=t.active;
      if(!settingsOnly){
        if(!keep&&t.failures>=2)keep=true;
        if(t.active)try {
          t.requestsPerMinute=await traffic(t);
          t.recovery=t.health==='healthy'&&t.requestsPerMinute!==null&&t.requestsPerMinute<state.quietThreshold?t.recovery+1:0;
          if(t.recovery>=3&&now()-t.activeSince>=120000)keep=false;
          t.error=null;
        }catch(e){t.error=e.message;t.recovery=0;}
        else{t.recovery=0;t.requestsPerMinute=null;}
      }
      if(keep)wanted.push(t);
    }
    if(!stopped)await reconcile(wanted,current,settingsOnly?'บันทึกการตั้งค่าเว็บไซต์':'ปรับ Challenge ตามสุขภาพและทราฟฟิกของแต่ละเว็บไซต์');
  }
  const status=()=>structuredClone({...state,targets,activeHosts:observed});
  const guarded=()=>cycle().then(()=>{state.error=null;}).catch(e=>{state.error=e.message;for(const t of targets){t.failures=0;t.recovery=0;}});
  function tick(){if(stopped)return Promise.resolve();if(pending)return pending;pending=guarded().finally(()=>{pending=null;});return pending;}
  return {tick,status,async configure(input){
    const settings=typeof input==='boolean'?{enabled:input}:input;
    if(typeof settings?.enabled!=='boolean')throw Error('enabled must be boolean');
    const rows=settings.targets===undefined?null:validateTargets(settings.targets);
    if(settings.ruleId!==undefined&&(typeof settings.ruleId!=='string'||(settings.ruleId&&!/^[a-f0-9]{32}$/i.test(settings.ruleId))))throw Error('Rule ID ต้องเป็น 32 ตัว หรือเว้นว่าง');
    while(pending)await pending;
    pending=(async()=>{
      await load();if(rows)await checkZone(rows);
      if(settings.ruleId!==undefined&&settings.ruleId!==state.ruleId){
        await getRule();if(state.active)throw Error('ปิดโหมดอัตโนมัติเพื่อปลด Challenge เดิมก่อนเปลี่ยน Rule ID');
        if(settings.ruleId){const set=(await api(entrypoint)).result;const candidate=set?.rules?.find(r=>r.id===settings.ruleId);if(!candidate||!['challenge','js_challenge','managed_challenge'].includes(candidate.action))throw Error('ไม่พบกฎ Challenge ID นี้ใน zone');}
        state.ruleId=settings.ruleId;accepted=[];
        if(backups[state.ruleId])accepted=[backups[state.ruleId].expression,'false'];
      }
      state.enabled=settings.enabled;
      if(rows)targets=rows.map(c=>{const old=targets.find(t=>t.hostname===c.hostname&&t.healthPath===c.healthPath&&t.healthMode===c.healthMode);return old?{...old,...c}:fresh(c);});
      await save();
      try{await cycle({settingsOnly:true});state.error=null;}catch(e){state.error=e.message;}
    })().finally(()=>{pending=null;});await pending;return status();
  },start(){if(timer)return;stopped=false;void tick();timer=setInterval(()=>void tick(),30000);timer.unref();},async stop(){stopped=true;clearInterval(timer);timer=null;await pending;}};
}

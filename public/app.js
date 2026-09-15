const $=id=>document.getElementById(id);
const fmt=n=>n.toLocaleString('en-US',{maximumFractionDigits:1});
const time=n=>new Date(n).toLocaleTimeString('en-GB');
let banPage = 1, banPending = false;
function cells(values) {
  const tr = document.createElement('tr');
  for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
  return tr;
}
const banDate = value => value ? new Date(value).toLocaleString('th-TH') : '—';
async function pollProtection() {
  if (banPending) return;
  banPending = true;
  const search = $('ban-search').value, page = banPage;
  try {
    const response = await fetch(`/api/protection?${new URLSearchParams({ search, page })}`, { headers: { 'X-Dstat-Internal': '1' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('โหลดสถานะไม่สำเร็จ');
    const p = await response.json();
    if (search !== $('ban-search').value || page !== banPage) return;
    $('protection-status').textContent = !p.enabled ? 'ปิดการแบนอัตโนมัติ' :
      `${p.dryRun ? 'DRY RUN' : 'AUTO BLOCK'} · >${p.threshold} req/60s · ตรวจทุก ${p.scanSeconds ?? 15} วินาที · DDoS เข้าเกณฑ์ ${p.ddosCandidates ?? 0} IP · รอแบน ${p.queued ?? 0} IP · แบนพร้อมกัน ${p.parallelBans ?? 3} IP · เก็บแบนจนใกล้เต็ม${p.evidenceError ? ' · DDoS events: ' + p.evidenceError : ''}${p.error ? ' · ERROR: ' + p.error + (p.retryAt ? ' · ลองใหม่ ' + banDate(p.retryAt) : '') : ''}`;
    $('ban-connection').textContent = p.error ? 'ERROR / STALE' : p.syncedAt && Date.now() - p.syncedAt < 120000 ? '● CONNECTED' : 'WAITING / STALE';
    $('ban-active').textContent = p.active ?? '—'; $('ban-managed').textContent = p.managed ?? '—';
    $('ban-quota').textContent = p.quota ? `${fmt(p.quota.used)} / ${fmt(p.quota.limit)}` : 'รอตรวจเมื่อมีแบนใหม่';
    $('ban-candidates').textContent = p.queued ?? 0;
    $('ban-sync').textContent = `CF sync: ${banDate(p.syncedAt)} · โควตา: ${banDate(p.quota?.checkedAt)}`;
    $('ban-rows').replaceChildren(...(p.bans?.length ? p.bans.map(b => cells([b.ip, banDate(b.createdAt), b.reason, b.managed ? 'dstat' : 'ภายนอก'])) : [cells(['ยังไม่มีรายการแบนที่ตรงกับการค้นหา', '', '', ''])]));
    banPage = p.page || 1;
    $('ban-page-label').textContent = `หน้า ${banPage} / ${p.pages || 1} · ${p.matched || 0} รายการ`;
    $('ban-prev').disabled = banPage <= 1; $('ban-next').disabled = banPage >= (p.pages || 1);
    $('ban-events').replaceChildren(...(p.events?.length ? p.events.slice(0, 30).map(e => cells([banDate(e.time), e.type === 'ban' ? 'BLOCK' : 'UNBLOCK', e.ip, e.detail])) : [cells(['ยังไม่มีเหตุการณ์', '', '', ''])]));
  } catch (e) { $('protection-status').textContent = 'สถานะไม่พร้อมใช้งาน: ' + e.message; $('ban-connection').textContent = 'DISCONNECTED / STALE'; }
  finally { banPending = false; }
}
$('ban-search').oninput = () => { banPage = 1; pollProtection(); };
$('ban-prev').onclick = () => { banPage--; pollProtection(); };
$('ban-next').onclick = () => { banPage++; pollProtection(); };
pollProtection(); setInterval(pollProtection, 3000);
const splitGroups = [
  ['banned', 'IP แบนแล้ว', '#f68b82'], ['queued', 'รอแบน', '#efc567'],
  ['checked', 'ตรวจแล้ว ยังไม่แบน', '#aeed6b'], ['unassessed', 'ไม่พบในการตรวจล่าสุด', '#8da9ec']
];
let splitPoints = [], splitBusy = false;
function drawSplit() {
  const canvas = $('split-chart'), rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr);
  const left = 62, right = rect.width - 12, bottom = rect.height - 28, top = 15;
  const total = p => splitGroups.reduce((n, [key]) => n + p.groups[key].requests, 0);
  const max = Math.max(1, ...splitPoints.map(total)) * 1.1;
  c.font = '10px monospace'; c.fillStyle = '#91a0b4';
  for (let i = 0; i <= 4; i++) {
    const y = bottom - (bottom - top) * i / 4; c.strokeStyle = '#263242'; c.beginPath(); c.moveTo(left,y); c.lineTo(right,y); c.stroke();
    c.fillText(Intl.NumberFormat('en', { notation: 'compact' }).format(max * i / 4), 2, y + 4);
  }
  if (!splitPoints.length) { c.fillText('Waiting for Cloudflare data', left + 10, top + 35); return; }
  const end = splitPoints.at(-1).time, start = end - 29.5 * 60000;
  const width = Math.max(2, (right - left) / 60 * 0.8);
  for (const point of splitPoints) {
    let y = bottom; const x = left + (point.time - start) / (end - start) * (right - left - width);
    for (const [key, , color] of splitGroups) { const h = point.groups[key].requests / max * (bottom - top); c.fillStyle = color; c.fillRect(x, y - h, width, h); y -= h; }
  }
  c.fillStyle = '#91a0b4'; c.fillText(time(start), left, bottom + 20); c.textAlign = 'right'; c.fillText(time(end), right, bottom + 20); c.textAlign = 'left';
}
async function pollSplit() {
  if (splitBusy) return; splitBusy = true;
  try {
    const response = await fetch('/api/protection-traffic', { headers: { 'X-Dstat-Internal': '1' }, signal: AbortSignal.timeout(45000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'อ่านกราฟไม่สำเร็จ');
    splitPoints = data.points || []; const latest = splitPoints.at(-1);
    $('split-metrics').replaceChildren(...splitGroups.map(([key,label,color]) => {
      const div = document.createElement('div'); div.style.color = color;
      const title = document.createElement('span'), value = document.createElement('strong'), note = document.createElement('small');
      title.textContent = label; value.textContent = latest ? fmt(latest.groups[key].requests) : '—';
      note.textContent = latest ? `${fmt(latest.groups[key].ips)} IP · req/60s` : 'รอข้อมูล'; div.append(title,value,note); return div;
    }));
    $('split-status').textContent = `${data.stale ? 'ข้อมูลเก่า / ยังไม่พร้อม' : 'อัปเดตอัตโนมัติ'} · ดึงล่าสุด ${banDate(data.fetchedAt)}${latest?.limited ? ' · ถึงเพดาน 10,000 IP: ตัวเลขแสดงเฉพาะส่วนที่ดึงได้' : ''}${data.error ? ' · ' + data.error : ''}`;
    $('split-samples').replaceChildren(...splitPoints.slice(-5).reverse().map(p => cells([time(p.time), ...splitGroups.map(([key]) => fmt(p.groups[key].requests))])));
    drawSplit();
  } catch (e) { $('split-status').textContent = 'ข้อมูลอาจเก่า: ' + e.message; }
  finally { splitBusy = false; }
}
new ResizeObserver(drawSplit).observe($('split-chart').parentElement);
pollSplit(); setInterval(pollSplit, 5000);
let challengeBusy = false, challengeSaving = false, challengeDirty = false, challengeInitialized = false, challengeConfig = null, savedRuleId = '';
const localSettings = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
function addChallengeRow(t = { hostname: '', healthPath: '/probe', healthMode: 'json', enabled: true }) {
  const row = document.createElement('div'); row.className = 'challenge-target';
  function field(title, element) { const label = document.createElement('label'); label.append(document.createTextNode(title), element); row.append(label); return element; }
  const host = field('เว็บไซต์', document.createElement('input')); host.value = t.hostname; host.placeholder = 'sub.cyber-safe.pro'; host.dataset.field = 'hostname';
  const path = field('Health path', document.createElement('input')); path.value = t.healthPath; path.dataset.field = 'healthPath';
  const mode = field('ตรวจว่าปกติจาก', document.createElement('select')); mode.dataset.field = 'healthMode';
  for (const [value,text] of [['json','200 + JSON ok:true'],['status','HTTP 200']]) { const option = document.createElement('option'); option.value=value; option.textContent=text; mode.append(option); } mode.value=t.healthMode;
  const on = field('ตรวจเว็บนี้', document.createElement('input')); on.type='checkbox'; on.checked=t.enabled; on.dataset.field='enabled';
  const remove=document.createElement('button'); remove.type='button'; remove.textContent='ลบ'; remove.onclick=()=>{row.remove();markChallengeDirty();};row.append(remove);
  for(const e of row.querySelectorAll('input,select,button'))e.disabled=!localSettings;
  row.oninput=markChallengeDirty;row.onchange=markChallengeDirty;$('challenge-targets').append(row);
}
function readChallengeRows(){return [...$('challenge-targets').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-field]')].map(e=>[e.dataset.field,e.type==='checkbox'?e.checked:e.value])));}
function markChallengeDirty(){challengeDirty=JSON.stringify(readChallengeRows())!==challengeConfig || $('challenge-rule-id').value.trim()!==savedRuleId;$('challenge-settings-note').textContent=challengeDirty?'มีการแก้ไขที่ยังไม่บันทึก':'บันทึกแล้ว';}
function renderChallenge(s) {
  if(!challengeDirty){savedRuleId=s.ruleId||'';$('challenge-rule-id').value=savedRuleId;}
  $('challenge-rule-id').disabled=!localSettings;
  $('auto-challenge-enabled').checked = s.enabled;
  $('auto-challenge-enabled').disabled = !localSettings;
  $('challenge-add').disabled=$('challenge-save').disabled=!localSettings;
  const incomingConfig=JSON.stringify((s.targets||[]).map(({hostname,healthPath,healthMode,enabled})=>({hostname,healthPath,healthMode,enabled})));
  if(!challengeDirty&&(!challengeInitialized||incomingConfig!==challengeConfig)){$('challenge-targets').replaceChildren();for(const t of s.targets||[])addChallengeRow(t);challengeInitialized=true;challengeConfig=incomingConfig;}
  const health = { waiting: 'รอตรวจ', healthy: 'ปกติ', down: 'ล่ม/เชื่อมต่อไม่ได้', unknown: 'ยืนยันไม่ได้' };
  $('auto-challenge-status').textContent = `โหมดอัตโนมัติ: ${s.enabled ? 'เปิด' : 'ปิด'} · Zone: ${s.zoneName || 'รอตรวจ'} · Challenge: ${s.active === null ? 'รอยืนยัน' : s.activeHosts?.join(', ') || 'ปิดทุกเว็บ'}${s.error ? ' · ERROR: ' + s.error : ''}`;
  const statusList=document.createElement('div');statusList.className='challenge-live';
  for(const t of s.targets||[]){const line=document.createElement('p');line.textContent=`${t.hostname} · ${t.enabled?'เปิดตรวจ':'ปิดตรวจ'} · ${health[t.health]}${t.httpStatus?' HTTP '+t.httpStatus:''} · Challenge ${t.active?'เปิด':'ปิด'} · ล่ม ${t.failures}/2 · ฟื้น ${t.recovery}/3 · ${t.requestsPerMinute===null?'ทราฟฟิกยังไม่มีข้อมูล':fmt(t.requestsPerMinute)+' req/min'} · ${banDate(t.checkedAt)}${t.error?' · '+t.error:''}`;statusList.append(line);}
  $('auto-challenge-status').append(statusList);
  const last=s.events?.[0];$('auto-challenge-event').textContent=last?`${banDate(last.time)} · ${last.reason} · เว็บที่ Challenge: ${last.hosts?.join(', ') || (last.active?'เปิด':'ไม่มี')}`:'เฝ้าระวังตามรายการเว็บที่ตั้งค่า';
}
async function pollChallenge(){
  if(challengeBusy||challengeSaving)return;challengeBusy=true;
  try{const r=await fetch('/api/auto-challenge',{headers:{'X-Dstat-Internal':'1'},signal:AbortSignal.timeout(10000)});const s=await r.json();if(!r.ok)throw Error(s.error);if(!challengeSaving)renderChallenge(s);}
  catch(e){if(!challengeSaving)$('auto-challenge-status').textContent='สถานะอาจเก่า: '+e.message;}
  finally{challengeBusy=false;}
}
async function saveChallenge(includeTargets){
  if(challengeSaving||!challengeInitialized)return;
  const payload={enabled:$('auto-challenge-enabled').checked};
  if(includeTargets){payload.targets=readChallengeRows();payload.ruleId=$('challenge-rule-id').value.trim();}
  challengeSaving=true;for(const e of document.querySelectorAll('.auto-challenge-panel input,.auto-challenge-panel select,.auto-challenge-panel button'))e.disabled=true;
  try{
    const r=await fetch('/api/auto-challenge',{method:'POST',headers:{'Content-Type':'application/json','X-Dstat-Settings':'1','X-Dstat-Internal':'1'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
    const s=await r.json();if(!r.ok)throw Error(s.error||'บันทึกไม่สำเร็จ');
    if(includeTargets)challengeDirty=false;renderChallenge(s);$('challenge-settings-note').textContent=s.error?'บันทึกแล้ว แต่ Cloudflare ยังไม่ยืนยัน: '+s.error:'บันทึกแล้ว';
  }catch(e){$('challenge-settings-note').textContent='ยืนยันการบันทึกไม่ได้: '+e.message;}
  finally{challengeSaving=false;for(const e of document.querySelectorAll('.auto-challenge-panel input,.auto-challenge-panel select,.auto-challenge-panel button'))e.disabled=!localSettings;await pollChallenge();}
}
$('auto-challenge-enabled').onchange=()=>saveChallenge(false);
$('challenge-add').onclick=()=>{if($('challenge-targets').children.length>=10)return;addChallengeRow();markChallengeDirty();};
$('challenge-save').onclick=()=>saveChallenge(true);
pollChallenge();setInterval(pollChallenge,5000);


$('challenge-rule-id').oninput=markChallengeDirty;

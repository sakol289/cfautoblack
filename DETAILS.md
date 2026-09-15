# dstat

Dashboard สำหรับวัด HTTP requests per second — Node.js 22+ ไม่มี npm dependencies

## เปิดใช้งาน

```sh
cp .env.example .env
npm start
```

เปิด http://127.0.0.1:3347

- **Local live (ค่าเริ่มต้น)**: นับ request ทุก path และทุก method ที่ถึง process นี้จริงในแต่ละวินาที แสดง 60 วินาทีล่าสุด หน้า dashboard จะส่ง header `X-Dstat-Internal: 1` ตอน poll `/api/...` เพื่อไม่ปั่นกราฟเอง และไม่นับ request ที่ Cloudflare บล็อกก่อนถึง origin
- **Test bench**: ส่ง request จากเบราว์เซอร์ไป `/probe` ของเซิร์ฟเวอร์เดียวกัน 1–50 req/s เป็นเวลา 10 วินาที มีปุ่มหยุด อัตราที่ได้รับจริงขึ้นกับ browser/network เป็น functional test ไม่ใช่ load benchmark
- **Cloudflare**: ตั้ง `CF_ZONE_ID` และ `CF_API_TOKEN` ใน `.env` แล้ว restart ใช้ token ที่มี Zone Analytics Read เฉพาะ zone เป้าหมาย เก็บ token ฝั่ง server ไม่ส่งให้ browser

Cloudflare ใช้ `httpRequestsAdaptiveGroups` จัดกลุ่ม `datetimeMinute` และ `count / 60` สำหรับค่าเฉลี่ย req/s ต่อหนึ่งนาที ช่วงย้อนหลัง 60 นาที ดึงใหม่ทุก 60 วินาที เฉพาะนาทีที่สิ้นสุดแล้ว ข้อมูลอาจ sampling/ล่าช้าและขึ้นกับสิทธิ์ dataset ของแพ็กเกจ ไม่มีข้อมูลแสดงเป็นว่าง ไม่เติมศูนย์สำหรับนาทีที่ไม่มี sample Average คำนวณเฉพาะ sample ที่มี หาก query ล้มเหลวจะแสดง error และระบุข้อมูลเก่าว่า stale ไม่มี fallback เป็นข้อมูลจำลอง

[Cloudflare GraphQL](https://developers.cloudflare.com/analytics/graphql-api/)
[Adaptive groups](https://developers.cloudflare.com/analytics/graphql-api/migration-guides/graphql-api-analytics/)
[Sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)

ค่าเริ่มต้น bind 0.0.0.0 สำหรับใช้ส่วนตัว หากเปิดให้เครื่องอื่นเข้าถึงด้วย `HOST=0.0.0.0` ควรใส่ authentication ที่ reverse proxy ก่อน เพราะ dashboard ไม่มีระบบ login และเปิดอ่าน traffic analytics ได้ ระบบ auto blacklist ตั้งค่าได้ตามหัวข้อด้านล่าง

ข้อมูล Local เก็บในหน่วยความจำ process เดียวและหายเมื่อ restart ไม่รวมหลาย replica กราฟ CF ไม่แสดง IP/ข้อมูลส่วนบุคคล CSV มี source และ interval กำกับ

## ตรวจสอบ

```sh
npm test
```

## Cloudflare auto ban — IP Access Rules

Worker อ่าน `clientIP` จาก Cloudflare Analytics ทุก 15 วินาที แล้วสร้าง **zone-level IP Access Rule → Block** โดยตรง เว็บจริงไม่ผ่าน dstat และไม่ต้องเปิด dashboard ให้ worker ทำงาน

- ตั้ง `CF_ZONE_ID`, `CF_ACCOUNT_ID`, `CF_API_TOKEN` หรือคู่ `CF_API_KEY` / `CF_API_EMAIL` ใน `.env` Token ต้องอ่าน Zone Analytics, รายชื่อทุก zone ใน account และ IP Access Rules ของ account/ทุก zone เพื่อเช็กโควตา รวมถึงสร้างและลบ IP Access Rules ของ zone เป้าหมาย
- เปิดด้วย `CF_PROTECTION_ENABLED=true`, `CF_PROTECTION_DRY_RUN=false` แล้ว `npm start` ใช้ `true` สำหรับ dry run ที่อ่านข้อมูลอย่างเดียว
- เกณฑ์ปัจจุบัน: >300 requests/นาที ในหน้าต่างย้อนหลัง 60 วินาที แบนคิวต่อเนื่องครั้งละ 3 IP พร้อมกัน ตรวจซ้ำ 3 หน้าต่างย้อนหลังเพื่อรับข้อมูลที่มาช้า คิวส่วนเกินเก็บใน `data/ban-queue.json` ข้ามรอบและ restart ได้ คิวเก็บจนประมวลผลสำเร็จหรือ IP ถูกเพิ่มใน allowlist ปรับได้ใน `.env.example`
- แบนไม่หมดอายุ เมื่อจำนวนกฎบัญชีแตะ `CF_BAN_CAPACITY=49000` จากเพดาน 50,000 จะปลดกฎแบนเก่าสุดหนึ่งรายการต่อแบนใหม่ เลือกเฉพาะกฎที่มี marker ของ dstat และ scope ตรงกับ zone นี้ และไม่เลือก IP ที่ยังพบ traffic สูงในรอบนั้น ไม่ใช้ความเงียบหลังบล็อกเป็นคะแนนความเสี่ยง
- ไม่ลบกฎ manual/กฎของ zone อื่น หากไม่มีรายการที่ปลดได้จะหยุดเพิ่มและแสดง error หากลบสำเร็จแต่สร้างใหม่ล้มเหลว ประวัติจะแสดงการปลดจริงและ error โดยไม่อ้างว่าสร้างสำเร็จ
- เช็กจำนวนกฎระดับ account และทุก zone ทุก 5 นาที (ก่อนปลดเก่าจะใช้ข้อมูลอายุไม่เกิน 60 วินาที) จำนวนรวมเป็น **ค่าประมาณแบบเผื่อสูง** เพราะ inherited rules อาจถูกนับซ้ำ เก็บที่สำรอง 1,000 กฎ และ API ยังเป็นตัวตัดสิน quota จริง
- `CF_ALLOW_IPS` ยกเว้น IP แบบเจาะจง คั่น comma; ไม่ลบแบนเดิม ไม่รองรับ CIDR ในตัวตรวจอัตโนมัติ

### Dashboard

เปิดหน้าแรก: แสดง active bans, กฎที่ dstat ดูแล, quota โดยประมาณ, IP เข้าเกณฑ์, เวลา sync, ตารางค้นหา IP/แบ่งหน้า และประวัติแบน/ปลดแบน หน้า poll cache ฝั่ง server ทุก 3 วินาที ไม่ยิง Cloudflare ต่อผู้ชมหนึ่งคน การ sync รายการแบนจาก CF ทำทุก 60 วินาทีและอาจใช้เวลานานกว่านั้นเมื่อจำนวนกฎมาก ส่วน Analytics เป็น sampled data และมีความหน่วง จึงไม่ใช่การตรวจโจมตีแบบ real-time

API `GET /api/protection?search=...&page=1` เป็น read-only หน้าเว็บไม่มีปุ่มแก้ไขหรือลบแบน เก็บเหตุการณ์ล่าสุด 200 รายการใน `data/ban-events.json` (หน้าแสดงล่าสุด 30 รายการ) หลัง restart อ่านสถานะแบนจาก Cloudflare ใหม่ ไม่ต้องพึ่งรายการ IP ใน memory เดิม กฎ dstat มี note บอกเหตุผลเพื่อกู้ ownership ได้

### ย้ายจาก black รุ่นเดิม

หยุด process dstat เดิม แล้ว `npm run protection:setup` สคริปต์อ่าน list `black` เดิม สร้าง Block ราย IP และปิดเฉพาะ custom rule ชื่อ `dstat automatic IP blacklist` เมื่อทุกรายการถูกแบนแล้ว เก็บ list เดิมไว้แต่ worker ใหม่ไม่ใช้ list หากพบ CIDR ที่ไม่รองรับหรือกฎ allow/challenge ขัดกัน จะหยุดโดยไม่ปิดกฎเดิม ต้องมีสิทธิ์ Lists Read และ Zone WAF Edit เฉพาะขั้นตอนย้าย

รัน worker เพียง instance เดียวต่อ zone เพื่อไม่ให้แบน/ปลดแข่งกัน ปิดการเพิ่มด้วย `CF_PROTECTION_ENABLED=false` แล้ว restart กฎที่ Cloudflare ยังบล็อกต่อจนลบเอง ไม่มี auto-expiry

[IP Access Rules](https://developers.cloudflare.com/waf/tools/ip-access-rules/) · [API](https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/)

### การตรวจเร็วและคิวต่อเนื่อง

ค่าปัจจุบัน >300 req/IP ในหน้าต่างย้อนหลัง 60 วินาที ตรวจทุก 15 วินาที รวม 3 หน้าต่างย้อนหลังเพื่อรับข้อมูลที่ล่าช้า ไม่ต้องรอให้จบนาทีปฏิทิน Analytics ยังคง sampling/ล่าช้า; รอบตรวจ 15 วินาทีไม่ใช่การรับประกันแบนภายใน 15 วินาที

ระบายคิวต่อเนื่องครั้งละ 3 IP พร้อมกัน (`CF_MAX_ADDS_PER_CYCLE` จำกัดได้ต่ำกว่า 3) บันทึกผลทีละรายการเพื่อไม่ให้ไฟล์ประวัติชนกัน การอ่านสถานะ CF sync ทุก 60 วินาที กฎที่ใกล้เต็มใช้ขั้นตอนปลดเก่า/แบนใหม่เรียงลำดับเดิม API ทั้ง process เว้นการเริ่ม request อย่างน้อย 400ms (เพดานประมาณ 150 API calls/นาที รวม reads และ writes) เพื่อเหลือส่วนเผื่อจากเพดาน Cloudflare 1,200/5 นาทีที่แชร์กับ dashboard และโปรแกรมอื่น เมื่อได้รับ HTTP 429 หยุดตาม Retry-After; ถ้าไม่ส่ง header รอ 5 นาที ไม่ลอง POST ซ้ำทันที และ sync กฎก่อน retry เพื่อไม่เพิ่มซ้ำเมื่อผลลัพธ์ไม่แน่ชัด

ตามคำขอผู้ใช้ ใช้ auto IP blacklist เป็นหลักขณะทดสอบ ไม่เปิด UAM; Managed Challenge เป็นตัวเสริมตามเงื่อนไขหัวข้อด้านล่าง กฎ `dstat flood protection - dstatv2 root` ไม่อยู่ในชุดกฎปัจจุบันแล้ว; worker ไม่มีโค้ดสร้างหรือเปิดกฎนี้กลับ

### หลักฐาน DDoS สำหรับ IP ที่ไม่ถึงเกณฑ์ปริมาณ

`CF_DDOS_EVIDENCE=true` ตรวจ Security Events เพิ่มทุกครั้งที่สแกน เฉพาะ `source=l7ddos` และ `action=block` ย้อนหลัง 3 นาที หาก IP เดียวพบอย่างน้อย 3 เหตุการณ์ ให้เข้าคิวแบนโดยไม่ต้องถึงเกณฑ์ 300 req/60s ยังคงยกเว้น allowlist และกฎ IP ที่มีอยู่ เหตุผลแยกเป็น DDoS ในตารางและประวัติ แบน DDoS ก่อนคิวปริมาณทั่วไป

ดึงสูงสุด 10,000 events ล่าสุดต่อครั้ง ข้อมูลอาจ sampled และไม่ครบทุกผู้โจมตีเมื่อถึงเพดาน (`ddosSampleLimit` ใน API) ความล้มเหลวของ Security Events แสดง `evidenceError` แต่ยังใช้เกณฑ์ปริมาณต่อได้ ตัวตรวจ IP นี้ไม่เปิด UAM/Challenge เอง

### กราฟแยกสถานะ IP

`GET /api/protection-traffic` ใช้ Cloudflare HTTP Analytics แยก request ตามสถานะ IP ณ ตอนเก็บจุด: แบนแล้ว, รอแบน, อยู่ในชุด IP ที่ worker ตรวจล่าสุดแต่ยังไม่แบน, และไม่อยู่ในชุดตรวจล่าสุด กลุ่มสุดท้ายไม่ใช่หลักฐานว่า Cloudflare ไม่เคยตรวจ IP นั้น และกลุ่มแบนแล้วไม่ใช่จำนวน request ที่ยืนยัน Block สำเร็จ

ดึงทุก 30 วินาทีเมื่อเปิดกราฟ โดยแชร์ cache ฝั่ง server ระหว่างผู้ชม แต่ละจุดนับย้อนหลัง 60 วินาที (ช่วงซ้อนกัน ห้ามบวกเป็นยอดรวม) เก็บ 60 จุดใน memory และหายเมื่อ restart เริ่มกราฟเมื่อเปิดดู ข้อมูลยังเป็น sampled Analytics และมีความหน่วง หากถึง 10,000 IP จะแจ้งว่าตัวเลขเป็นเพียงส่วนที่ดึงได้ ถ้า API ผิดพลาดคงกราฟเก่าและแสดง stale ไม่เติมศูนย์แทน error


### Challenge อัตโนมัติเมื่อเว็บล่ม

ตั้ง `CF_AUTO_CHALLENGE=true` และ `CF_CHALLENGE_HOST=dstatv2.cyber-safe.pro` หรือใช้สวิตช์บน dashboard ที่ localhost การตั้งค่าจากสวิตช์เก็บใน `data/auto-challenge.json` และมีผลเหนือค่า env หลัง restart ต้องมีสิทธิ์ Zone WAF Edit และช่อง custom rule ว่างหนึ่งช่อง

- ตรวจ `/probe` ทุก 30 วินาที timeout 8 วินาที หาก 5xx หรือเชื่อมต่อไม่ได้ 2 รอบติดกัน เปิดกฎ `dstat automatic outage challenge` แบบ Managed Challenge เฉพาะ GET/HEAD ของ hostname ที่ล่ม ยกเว้น health path ที่ตั้งไว้ วางก่อนกฎ Skip
- ปิดเมื่อ `/probe` ตอบ JSON `ok: true` และ Analytics ของ 2 นาทีที่จบแล้วต่ำกว่า 6,000 req/min ทั้งสองนาที ต่อเนื่อง 3 รอบ พร้อมเปิดมาอย่างน้อย 2 นาที นับทราฟฟิกทั้งหมดรวมที่ถูกบล็อก จึงไม่ใช้ความเงียบที่ origin หลัง challenge เป็นหลักฐานว่าหยุดยิง
- หากข้อมูล Analytics ไม่ครบหรือ API ล้มเหลว คง Challenge ไว้และแสดงสถานะ ไม่แทนข้อมูลหายด้วยศูนย์ ตัวเลขเป็น sampled/delayed Analytics จึงเป็นเกณฑ์ทราฟฟิกสงบ ไม่ใช่การยืนยันว่าการโจมตีจบแล้ว
- ปิดสวิตช์จะปิดเฉพาะกฎที่ระบบนี้ดูแล พร้อมเก็บประวัติ ไม่เปลี่ยน zone-wide UAM ระบบ auto IP ban ทำงานแยกกัน
- `POST /api/auto-challenge` แก้ได้จาก localhost origin เดียวกันเท่านั้น หน้าจอ remote อ่านสถานะได้แต่สวิตช์ถูกปิดใช้งาน

`/probe` ตรวจการตอบสนองของ process ไม่ได้ตรวจฐานข้อมูลหรือทุกหน้า และกฎครอบคลุม GET/HEAD ของเว็บที่เข้าเงื่อนไข ยกเว้น health path หาก process ของตัว monitor หยุดทำงานจะไม่สามารถสั่งเปิด/ปิดได้ ควรรันแยกจาก origin ที่ถูกโจมตี

[Cloudflare: เพิ่มกฎและกำหนดลำดับ](https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/)


### รายการเว็บไซต์ที่เฝ้าระวัง

หน้าตั้งค่า Challenge เพิ่ม/ลบเว็บได้สูงสุด 10 เว็บ ภายใน `CF_ZONE_ID` เดียวกันเท่านั้น ค่าเริ่มต้นยังเป็น `dstatv2.cyber-safe.pro` แต่ละรายการกำหนด hostname, health path เช่น `/probe` หรือ `/health`, รูปแบบตรวจ HTTP 200 หรือ HTTP 200 + JSON `ok:true` และสวิตช์ตรวจเว็บนั้น กด **บันทึกรายการเว็บ** เพื่อใช้งาน ค่าคงอยู่หลัง restart

ตัวควบคุมตรวจสุขภาพและทราฟฟิกแยกตาม hostname ใช้ custom rule ร่วมหนึ่งกฎ โดย expression รวมเฉพาะเว็บที่เข้าเงื่อนไขด้วย `or` เว็บที่ปกติหรือไม่ได้กำหนดจะไม่อยู่ในกฎ ปิดสวิตช์รายเว็บหรือลบรายการแล้วบันทึก จะนำเว็บนั้นออกจาก Challenge โดยเว็บที่ยังล่มคงอยู่ ไม่ลบกฎอื่นหรือขยายเป็นทั้ง zone

Health path ต้องเป็น endpoint เฉพาะที่บอกสุขภาพจริง ไม่ใช้ `/` และไม่ redirect หากตอบ 403/404/429 หรือ JSON ไม่ตรงจะแสดง “ยืนยันไม่ได้” ไม่ถือว่าเว็บฟื้น ควรเลือก endpoint ที่ทดสอบ dependency สำคัญด้วย ระบบยกเว้น health path เฉพาะจากกฎ Challenge นี้ ไม่ยกเว้น WAF หรือกฎอื่น


### ผลการป้องกันในแท็บ Cloudflare

แท็บ Cloudflare แสดงยอดเข้าทั้งหมด, Block, Challenge, Allow/Skip/อื่น ๆ และไม่ทราบผล พร้อมกราฟรายนาทีและตาราง 10 นาทีล่าสุด ใช้ `httpRequestsAdaptiveGroups` dimensions `datetimeMinute` + `securityAction` จากช่วง 60 นาทีที่สิ้นสุดแล้วทั้ง zone ดึงทุก 60 วินาทีผ่าน cache ร่วม ยอดทั้งหมดรวมจากชุดเดียวกับผลการป้องกันเพื่อไม่ผสมตัวเลขคนละ sample

Block คือ action `block`; Challenge รวม `challenge`, `js_challenge`, `managed_challenge`; solved/bypassed แยกไปกลุ่มอื่น ไม่ถือว่าเป็น Challenge ใหม่ ค่า unknown หรือ action ที่ไม่รู้จักอยู่ในกลุ่มไม่ทราบผล ไม่ได้แปลว่าผ่านถึง origin ตัวเลขนับ requests ไม่ใช่ IP และข้อมูล sampled/ล่าช้า เมื่อ API ผิดพลาดแสดง stale และไม่แทนด้วยศูนย์

[Cloudflare security fields](https://developers.cloudflare.com/logs/reference/change-notices/2023-02-01-security-fields-updates/)

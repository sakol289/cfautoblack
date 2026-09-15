# Protection system

คัดลอกโฟลเดอร์นี้ไปใช้กับเว็บอื่นได้อิสระจาก dstat ใช้ Node.js >=22

1. คัดลอก `.env.example` เป็น `.env` แล้วตั้ง `CF_ZONE_ID`, `CF_ACCOUNT_ID` และ credentials ของเว็บปลายทาง
2. ตั้ง `CF_CHALLENGE_HOST` เป็นเว็บเริ่มต้น และ `CF_UAM_RULE_ID` เป็น Rule ID ของ custom rule ประเภท Challenge ใน zone เดียวกัน หรือเว้นว่างให้ระบบสร้างกฎเฉพาะ
3. `npm start` เปิด http://127.0.0.1:3348/ ตั้งรายการ hostname/health path และบันทึก
4. เปิด auto ban ด้วย `CF_PROTECTION_ENABLED=true`, `CF_PROTECTION_DRY_RUN=false` เปิด health-triggered Challenge ด้วยสวิตช์หรือ `CF_AUTO_CHALLENGE=true`

## Rule ID ของ UAM / Challenge

หมายถึง ID ของ **custom rule** ไม่ใช่ Zone ID และไม่ใช่ zone-wide Under Attack Mode รองรับ action `challenge`, `js_challenge`, `managed_challenge` ระบบคงชนิด action เดิมแต่ควบคุม enabled และ expression: เฉพาะ GET/HEAD ของ hostname ที่เข้าเงื่อนไข ยกเว้น health path เก็บสำเนากฎเดิมใน `data/auto-challenge.json` ก่อนแก้ไข

เปลี่ยน ID ได้ที่หน้าเว็บ ต้องปิดโหมดและยืนยันว่า Challenge เดิมปิดก่อนเปลี่ยน ID กฎที่ไม่ใช่ Challenge หรือ ID นอก zone จะถูกปฏิเสธ ไม่แตะกฎอื่น ค่าที่บันทึกในหน้าเว็บมีผลเหนือ env

## ใช้กับเว็บไซต์อื่น

หนึ่ง instance ต่อหนึ่ง zone แต่ละ instance รองรับได้สูงสุด 10 hostname ใน zone นั้น หากใช้หลาย zone ให้แยกสำเนาโฟลเดอร์ `.env`, `data/` และพอร์ต **อย่านำ `.env` หรือ `data/` ของเว็บเดิมติดไปใช้กับเว็บใหม่** ให้เริ่มจาก `.env.example` และ data ว่าง

Health path ต้องตอบ HTTP 200 หรือ JSON `ok:true` ตามโหมดที่เลือก ตรวจทุก 30 วินาที ล่ม 2 รอบจึงเปิด Challenge; ฟื้นและทราฟฟิกต่ำกว่า 6,000 req/min 3 รอบ พร้อมเปิดอย่างน้อย 2 นาทีจึงปิด ข้อมูลหายไม่ถือว่าเงียบ ควรรัน monitor แยกจาก origin ที่ถูกโจมตี

Credentials ต้องอ่าน Analytics และจัดการ Zone WAF/IP Access Rules ได้ รวมถึงสิทธิ์อ่านโควตา account/zone ตามระบบ auto ban หน้าตั้งค่าแก้ได้ผ่าน localhost เท่านั้น ค่าเริ่มต้น bind 127.0.0.1

คิวแบน/ประวัติ/ค่าตั้งเก็บใน `data/` ปิด dstat ไม่กระทบ worker นี้ การปิด worker ไม่ลบกฎที่สร้างบน Cloudflare

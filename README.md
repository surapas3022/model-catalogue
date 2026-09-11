# Model Catalogue

Remote Config สำหรับสลับโมเดล AI และคิดราคา Token โดยร้านค้าไม่ต้อง redeploy แอป

ไฟล์ที่ร้านค้าดึงจาก CDN คือ `config.stable.json` ซึ่งเป็น **ซองที่เซ็นด้วย Ed25519** ไม่ใช่ JSON โมเดลตรง ๆ  
CDN / GitHub ทำได้แค่กระจายไฟล์ — ร้านค้าเชื่อเฉพาะลายเซ็นที่ตรวจด้วย **public key ที่ฝังในแอป**

Repo: [github.com/surapas3022/model-catalogue](https://github.com/surapas3022/model-catalogue)

---

## สำหรับ AI / เอเจนต์ (เอา config ไปใช้ในแอป)

ถ้ากำลัง implement ร้านค้าหรือบริการที่ดึง catalogue นี้ **อ่าน `llms.txt` ก่อน** แล้วคัดลอกสัญญาจากนั้น + ตัวอย่างใน `client.mjs`

- [`llms.txt`](llms.txt) — URL, public key, กฎ `adopt` / `resolveModel` / `calculateCost`, สิ่งที่ห้ามทำ
- [`catalogue.schema.json`](catalogue.schema.json) — schema ของ JSON ข้างใน `payload` หลังลายเซ็นผ่าน
- [`client.mjs`](client.mjs) — implementation อ้างอิง (Node.js 18+)

อย่าให้เอเจนต์ดึง `catalogue.src.json` มาใช้ตอนรัน — ไฟล์นั้นไม่ได้เซ็น ใช้เฉพาะคนดูแล repo

---

## แนวคิดสั้น ๆ

```
คนแก้ catalogue.src.json
        │
        ▼
  build.mjs เซ็น JSON.stringify(src) ด้วย private key
        │
        ▼
  config.stable.json / config.canary.json
  { "payload": "<string>", "sig": "<base64>" }
        │
        ▼
  CDN (jsDelivr)  →  ร้านค้าเรียก adopt() ตรวจลายเซ็น
        │
        ▼
  resolveModel() / calculateCost()
```

กฎฝั่งร้านค้าหลังลายเซ็นผ่านแล้ว:

1. ปฏิเสธถ้า `catalogue.version <= cachedVersion` (กัน replay / rollback)
2. ปฏิเสธถ้า `catalogue.minClientVersion > CLIENT_VERSION` (แอปเก่าเกิน)
3. ถ้า purpose ที่แอปส่งมาไม่มีใน catalogue ให้ใช้ `purposes.default`

---

## ดึงไฟล์จาก CDN

Stable (ใช้จริง):

```
https://cdn.jsdelivr.net/gh/surapas3022/model-catalogue@main/config.stable.json
```

Canary (ทดลอง):

```
https://cdn.jsdelivr.net/gh/surapas3022/model-catalogue@main/config.canary.json
```

GitHub raw สำรอง:

```
https://raw.githubusercontent.com/surapas3022/model-catalogue/main/config.stable.json
```

อย่า pin เป็น `@latest` แบบหลวมจนเกินไปใน production — แนะนำ `@main` แล้วให้ workflow purge cache หลัง publish หรือ pin เป็น commit SHA เมื่อต้องการล็อกรุ่น

---

## ฝั่งร้านค้า (เอาไปใช้ในแอป)

ต้องใช้ Node.js 18+ เพราะพึ่ง `node:crypto` สำหรับ Ed25519  
คัดลอกแนวทางจาก `client.mjs` ไปไว้ในบริการของร้าน **ห้ามโหลด public key จาก CDN**

Public key ปัจจุบัน (ต้องตรงกับ `catalogue-public.pem`):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdizLWdyfd6FznkuXBxX8fOG94aAF/ndNpwvMS07kj7I=
-----END PUBLIC KEY-----
```

### ขั้นที่ 1 — ดึงซองที่เซ็นแล้ว

```js
const url =
  "https://cdn.jsdelivr.net/gh/surapas3022/model-catalogue@main/config.stable.json";

const signed = await fetch(url).then((res) => {
  if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);
  return res.json();
});
```

`signed` ต้องมีรูป `{ payload: string, sig: string }`

### ขั้นที่ 2 — ตรวจลายเซ็นแล้วรับ catalogue

```js
import { adopt, resolveModel, calculateCost, CLIENT_VERSION } from "./client.mjs";

const cachedVersion = Number(localStorage.getItem("catalogueVersion") ?? 0);
const catalogue = adopt(signed, cachedVersion);

localStorage.setItem("catalogueVersion", String(catalogue.version));
localStorage.setItem("catalogue", JSON.stringify(catalogue));
```

`adopt()` จะ throw เมื่อ:

| สาเหตุ | ความหมาย |
|---|---|
| `catalogue signature is invalid` | ไฟล์ถูกแก้ / คนละคีย์ |
| `version ... is not newer than cached` | ซ้ำหรือเก่ากว่าของที่เก็บไว้ |
| `client version ... is below ... minClientVersion` | แอปต้องอัปเดตก่อน |

ถ้า throw ให้ใช้ catalogue เก่าที่ cache ไว้ต่อ อย่าใช้ payload ที่ตรวจไม่ผ่าน

ครั้งแรกที่ยังไม่มี cache ให้ส่ง `cachedVersion = 0`

### ขั้นที่ 3 — เลือกโมเดลตาม feature

```js
const { modelId, model, fallbackUsed } = resolveModel(catalogue, "order-slip-ocr");

// เรียก AI ด้วย modelId
```

พฤติกรรม:

- มี key ของ purpose → เดินรายการโมเดลจากซ้ายไปขวา ข้ามตัวที่ `retiresOn <= วันนี้`
- ไม่มี key ของ purpose (feature ใหม่ที่ catalogue เก่ายังไม่มี) → ใช้ `purposes.default`
- รายการของ purpose หมดอายุหมดแล้ว → ลอง `default` อีกครั้ง

ตัวอย่าง purpose:

| purpose | ใช้เมื่อ |
|---|---|
| `default` | fallback ของทุก feature ที่ยังไม่ได้กำหนด |
| `auto-reply` | ตอบแชทอัตโนมัติ |
| `order-intent` | ตีความคำสั่งซื้อ |
| `order-slip-ocr` | อ่านสลิปออเดอร์ |
| `kb-embed-index` / `kb-embed-query` | embedding ของ knowledge base |
| `attachment-vision` | รูปแนบที่ต้องใช้โมเดล vision |

รายการครบอยู่ใน `catalogue.src.json` → `purposes`

### ขั้นที่ 4 — คิดราคา Token

ราคาใน catalogue เป็น **USD ต่อ 1 ล้าน token** (`priceUnit: "1M_tokens"`)

```js
const cost = calculateCost(catalogue, modelId, {
  inputTokens: 12_000,
  cachedInputTokens: 3_000,
  outputTokens: 800,
});

console.log(cost.usd); // 0.005825
console.log(cost.thb); // usd * catalogue.usdToThb
```

สูตร:

```
usd = inputTokens/1e6 * input
    + cachedInputTokens/1e6 * cachedInput
    + outputTokens/1e6 * output

thb = usd * usdToThb
```

ถ้า `modelId` ไม่มีใน `models` จะใช้ `fallbackPrice`

### วงจรแนะนำใน production

1. ตอนบูตแอป: ใช้ catalogue ที่ cache ไว้ทันที (อย่ารอเครือข่าย)
2. พื้นหลัง: `fetch` ซองใหม่ → `adopt(signed, cachedVersion)`
3. ผ่านแล้วค่อยสลับโมเดล / อัตราแลกเปลี่ยน
4. ไม่ผ่านแล้วเงียบ ๆ ใช้ของเก่า

รันตัวอย่างใน repo นี้:

```bash
node client.mjs
```

---

## ฝั่งคนดูแล catalogue (แก้แล้วปล่อยรุ่น)

ต้องการ Node.js 18.19+

### โครงสร้างที่แตะจริง

| ไฟล์ | ใครแก้ |
|---|---|
| `catalogue.src.json` | คน | ต้นทางที่แก้ด้วยมือ |
| `catalogue-private.pem` | เครื่อง / GitHub Secret | ห้ามขึ้น Git |
| `catalogue-public.pem` | คน (อ่านอย่างเดียว) | คู่กับที่ฝังในแอป |
| `config.stable.json` | CI | ไฟล์ที่ร้านค้าดึง |
| `config.canary.json` | CI | ช่องทดลอง |
| `client.mjs` | แอปร้านค้า | ตัวอย่างการตรวจลายเซ็น |

### สร้างคีย์ครั้งแรก (ทำแล้วใน repo นี้)

```bash
node build.mjs --keygen
```

จะได้:

- `catalogue-private.pem` — เก็บในเครื่องและ GitHub Actions secret
- `catalogue-public.pem` — ฝังในแอปเป็น `CATALOGUE_PUBLIC_KEY`

อย่า `--force` ทับคีย์ถ้าแอปในร้านค้าฝัง public key ชุดนี้อยู่แล้ว  
หมุนคีย์ = ต้องออกแอปใหม่พร้อม public key ใหม่

### แก้โมเดล / ราคา / purpose

แก้เฉพาะ `catalogue.src.json` แล้ว **บวก `version` ทุกครั้งที่ปล่อย**  
ถ้าไม่บวก version ร้านค้าที่มี cache จะไม่ยอมรับไฟล์ใหม่ (anti-replay)

ฟิลด์สำคัญ:

| ฟิลด์ | ความหมาย |
|---|---|
| `version` | เลขเต็ม เพิ่มขึ้นเท่านั้น |
| `channel` | `stable` หรือ `canary` |
| `minClientVersion` | แอปที่ต่ำกว่านี้ใช้ catalogue นี้ไม่ได้ |
| `usdToThb` | อัตราแปลงตอนคิดเงินบาท |
| `models.*.retiresOn` | `YYYY-MM-DD` หรือ `null` |
| `purposes.default` | **ต้องมีเสมอ** และห้ามเป็นอาร์เรย์ว่าง |
| `fallbackPrice` | ราคาสำรองเมื่อไม่รู้จัก model id |

ลำดับในอาร์เรย์ purpose คือลำดับ fallback เช่น

```json
"auto-reply": ["gemini-3.7-flash", "gemini-3.5-flash-lite"]
```

หมายถึง ใช้ flash ก่อน ถ้าหมดอายุค่อยไป lite

### เซ็นไฟล์ในเครื่อง (ทดสอบ)

```bash
node build.mjs --channel stable
node build.mjs --channel canary
node client.mjs
```

Private key อ่านจาก:

1. `process.env.CATALOGUE_KEY` หรือ `CATALOGUE_PRIVATE_KEY`
2. ถ้าไม่มี env ค่อยอ่าน `catalogue-private.pem`

ผลลัพธ์คือ `config.{channel}.json` คนละไฟล์ คนละ payload เพราะค่า `channel` ใน JSON ต่างกัน

### ปล่อยขึ้น CDN อัตโนมัติ

1. เปิด repo → **Settings → Secrets and variables → Actions**
2. สร้าง secret ชื่อ `CATALOGUE_PRIVATE_KEY`
3. วางเนื้อ PEM ทั้งก้อนของ `catalogue-private.pem` รวมบรรทัด `BEGIN` / `END`
4. แก้ `catalogue.src.json` (อย่าลืมบวก `version`)
5. Push ขึ้น `main`

Workflow `.github/workflows/publish.yml` จะ:

- เซ็น `config.stable.json` และ `config.canary.json`
- commit กลับเข้า repo
- ยิง purge ไปที่ jsDelivr

จะรันเมื่อไฟล์เหล่านี้เปลี่ยนบน `main`:

- `catalogue.src.json`
- `build.mjs`
- `.github/workflows/publish.yml`

หรือกด **Run workflow** เองได้ (`workflow_dispatch`)

หลัง Actions เขียว รอ cache สั้น ๆ แล้วเปิด URL jsDelivr ด้านบน ควรได้ `version` ใหม่

---

## ความปลอดภัย (ห้ามข้าม)

- ร้านค้า **hard-code public key** ในแอป ห้ามดาวน์โหลดจาก GitHub/CDN
- **ห้าม commit** `catalogue-private.pem`
- อย่าใส่ private key ใน `client.mjs`
- อย่าเชื่อ `catalogue.src.json` จากเน็ต — นั่นเป็นไฟล์ต้นทางของคนดูแลเท่านั้น
- ถ้า payload ถูกแก้แม้ตัวเลขราคาเดียว ลายเซ็นจะไม่ผ่าน
- ถ้าต้องการ rollback catalogue ที่ร้านค้ารับไปแล้ว ต้องออก `version` ใหม่ที่สูงกว่าของที่ cache ไว้ ไม่ใช่ลดเลขกลับ

หมุนคีย์เมื่อสงสัยว่า private key รั่ว:

1. `node build.mjs --keygen --force`
2. อัปเดต GitHub secret
3. ฝัง public key ใหม่ในแอปแล้วปล่อยแอปใหม่
4. เซ็น catalogue ใหม่ด้วยคีย์ใหม่

---

## แก้ปัญหาบ่อย

| อาการ | สาเหตุที่พบบ่อย |
|---|---|
| `signature is invalid` | คนละคีย์ / แก้ `config.*.json` ด้วยมือ / แอปฝัง public key คนละชุด |
| ร้านค้าไม่ยอมรับไฟล์ใหม่ | ลืมบวก `version` |
| Actions ล้มที่ Missing secret | ยังไม่มี `CATALOGUE_PRIVATE_KEY` |
| jsDelivr ยังเป็นของเก่า | cache ยังไม่หมด ดูว่าขั้น Purge ใน Actions ผ่านหรือยัง |
| `no usable (non-retired) model` | โมเดลใน purpose หมดอายุหมด และ default ก็ใช้ไม่ได้ |
| `minClientVersion` error | แอปร้านค้า `CLIENT_VERSION` ต่ำกว่าที่ catalogue กำหนด |

---

## สคริปต์ใน `package.json`

```bash
npm run keygen         # สร้างคู่คีย์ Ed25519
npm run build          # เซ็นตาม channel ใน catalogue.src.json
npm run build:stable
npm run build:canary
npm run client         # เดโม adopt + resolve + คิดราคา
```

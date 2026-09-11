#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Public key คู่กับ catalogue-private.pem ที่ใช้เซ็น config.*.json
 * ฝั่งร้านค้า hard-code ค่านี้ — ห้ามดึงจาก CDN เพราะจะทำลาย Zero-Trust
 */
export const CATALOGUE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdizLWdyfd6FznkuXBxX8fOG94aAF/ndNpwvMS07kj7I=
-----END PUBLIC KEY-----
`;

export const CLIENT_VERSION = 4;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;
export const CHANNEL = process.env.CATALOGUE_CHANNEL ?? "stable";

const publicKey = createPublicKey(CATALOGUE_PUBLIC_KEY);

/** พื้นในไบนารี — ตอบได้ตอนยังไม่มี cache และเน็ตดับ version 0 เพื่อให้ catalogue จริงชนะเสมอ */
export const FLOOR = {
  version: 0,
  channel: CHANNEL,
  minClientVersion: 1,
  publishedAt: "1970-01-01T00:00:00Z",
  usdToThb: 36.5,
  priceUnit: "1M_tokens",
  models: {
    "gemini-3.5-flash-lite": {
      price: { input: 0.1, cachedInput: 0.025, output: 0.4 },
      vision: true,
      status: "ga",
      retiresOn: null,
    },
    "gemini-3.1-flash-lite": {
      price: { input: 0.1, cachedInput: 0.025, output: 0.4 },
      vision: false,
      status: "ga",
      retiresOn: null,
    },
  },
  purposes: { default: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"] },
  fallbackPrice: { input: 0.3, cachedInput: 0.075, output: 2.5 },
};

let current = FLOOR;

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function isRetired(model, today = todayUtcDate()) {
  if (!model || model.retiresOn == null || model.retiresOn === "") return false;
  // retiresOn เป็นวันที่หมดอายุ (YYYY-MM-DD) — ถึงหรือเลยวันนี้แล้วไม่ใช้
  return String(model.retiresOn).slice(0, 10) <= today;
}

function parseSignedEnvelope(rawSignedJson) {
  const envelope =
    typeof rawSignedJson === "string" ? JSON.parse(rawSignedJson) : rawSignedJson;
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    typeof envelope.sig !== "string"
  ) {
    throw new Error("signed catalogue must be { payload: string, sig: string }");
  }
  return envelope;
}

/**
 * ยืนยัน Ed25519 signature แล้วเปิด payload เป็น catalogue
 * Anti-Replay: ปฏิเสธเมื่อ c.version <= cachedVersion
 * Compatibility: ปฏิเสธเมื่อ c.minClientVersion > CLIENT_VERSION
 * เส้นทางบูต/รีเฟรชต้องเรียก tryAdopt ไม่ใช่ตัวนี้โดยตรง — ตัวนี้ยัง throw เพื่อแยกสาเหตุ
 */
export function adopt(rawSignedJson, cachedVersion = 0) {
  const { payload, sig } = parseSignedEnvelope(rawSignedJson);
  const signature = Buffer.from(sig, "base64");
  const ok = verify(null, Buffer.from(payload, "utf8"), publicKey, signature);
  if (!ok) {
    throw new Error("catalogue signature is invalid");
  }

  const catalogue = JSON.parse(payload);
  if (!Number.isInteger(catalogue.version)) {
    throw new Error("catalogue.version must be an integer");
  }
  // เวอร์ชันเท่าเดิมหรือเก่ากว่าของที่ cache ไว้ = replay / rollback
  if (catalogue.version <= cachedVersion) {
    throw new Error(
      `catalogue version ${catalogue.version} is not newer than cached version ${cachedVersion}`
    );
  }
  if (!Number.isInteger(catalogue.minClientVersion)) {
    throw new Error("catalogue.minClientVersion must be an integer");
  }
  // Catalogue บังคับ client ใหม่กว่าที่ร้านค้ามีอยู่
  if (catalogue.minClientVersion > CLIENT_VERSION) {
    throw new Error(
      `client version ${CLIENT_VERSION} is below catalogue.minClientVersion ${catalogue.minClientVersion}`
    );
  }
  if (catalogue.channel && catalogue.channel !== CHANNEL) {
    throw new Error(`catalogue is for channel ${catalogue.channel}, this build is ${CHANNEL}`);
  }
  if (!Array.isArray(catalogue.purposes?.default) || catalogue.purposes.default.length === 0) {
    throw new Error("catalogue.purposes.default is required");
  }

  return catalogue;
}

/** เปิดซองแล้วรับเข้า current ถ้าผ่าน — ล้มแล้วคืน null ไม่ throw */
export function tryAdopt(rawSignedJson) {
  try {
    const catalogue = adopt(rawSignedJson, current.version);
    current = catalogue;
    return catalogue;
  } catch {
    return null;
  }
}

export function catalogue() {
  return current;
}

function firstUsableModelId(cat, modelIds, today) {
  for (const modelId of modelIds) {
    const model = cat.models?.[modelId];
    if (!model) continue;
    if (isRetired(model, today)) continue;
    return modelId;
  }
  return null;
}

/**
 * เลือก model id ตัวแรกที่ยังไม่ retired สำหรับ purpose
 * ถ้าไม่มี key ของ purpose ใน catalogue ให้ใช้ purposes.default
 * ถ้ายังไม่มีตัวใช้ได้ ให้ตกลง FLOOR.purposes.default — ไม่ throw
 */
export function resolveModel(cat = current, purpose, today = todayUtcDate()) {
  const purposes = cat.purposes ?? {};
  // Feature ใหม่ที่ catalogue เก่ายังไม่มี key — ตกไป default
  const candidates =
    Array.isArray(purposes[purpose]) && purposes[purpose].length > 0
      ? purposes[purpose]
      : purposes.default;

  const resolved = firstUsableModelId(cat, candidates ?? [], today);
  if (resolved) {
    return {
      purpose: purposes[purpose] ? purpose : "default",
      requestedPurpose: purpose,
      modelId: resolved,
      model: cat.models[resolved],
      fallbackUsed: !purposes[purpose],
    };
  }

  // รายการของ purpose หมดอายุหมดแล้ว — ลอง default อีกครั้งถ้ายังไม่ได้ใช้
  if (purpose !== "default" && purposes[purpose]) {
    const defaultId = firstUsableModelId(cat, purposes.default, today);
    if (defaultId) {
      return {
        purpose: "default",
        requestedPurpose: purpose,
        modelId: defaultId,
        model: cat.models[defaultId],
        fallbackUsed: true,
      };
    }
  }

  const floorId = firstUsableModelId(FLOOR, FLOOR.purposes.default, today);
  if (floorId) {
    return {
      purpose: "default",
      requestedPurpose: purpose,
      modelId: floorId,
      model: FLOOR.models[floorId],
      fallbackUsed: true,
    };
  }

  return null;
}

function priceForModel(cat, modelId) {
  const nested = cat.models?.[modelId]?.price;
  if (nested) {
    return {
      input: nested.input,
      cachedInput: nested.cachedInput,
      output: nested.output,
      usedFallbackPrice: false,
    };
  }
  const fallback = cat.fallbackPrice ?? FLOOR.fallbackPrice;
  return {
    input: fallback.input,
    cachedInput: fallback.cachedInput,
    output: fallback.output,
    usedFallbackPrice: true,
  };
}

/**
 * คิดราคาต่อ 1 ล้าน token ตาม priceUnit ของ catalogue
 * usage: { inputTokens, cachedInputTokens, outputTokens }
 * อ่านจาก models[id].price ไม่ใช่ฟิลด์ราคาแบนบนโมเดล
 */
export function calculateCost(cat = current, modelId, usage = {}) {
  const inputTokens = Number(usage.inputTokens ?? 0);
  const cachedInputTokens = Number(usage.cachedInputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  if ([inputTokens, cachedInputTokens, outputTokens].some((n) => !Number.isFinite(n) || n < 0)) {
    return {
      modelId,
      error: "usage token counts must be finite numbers >= 0",
      usd: 0,
      thb: 0,
    };
  }

  const price = priceForModel(cat, modelId);
  const usd =
    (inputTokens / TOKENS_PER_PRICE_UNIT) * price.input +
    (cachedInputTokens / TOKENS_PER_PRICE_UNIT) * price.cachedInput +
    (outputTokens / TOKENS_PER_PRICE_UNIT) * price.output;
  const thb = usd * Number(cat.usdToThb ?? FLOOR.usdToThb);

  return {
    modelId,
    priceUnit: cat.priceUnit ?? FLOOR.priceUnit,
    usdToThb: cat.usdToThb,
    usedFallbackPrice: price.usedFallbackPrice,
    usage: { inputTokens, cachedInputTokens, outputTokens },
    rates: {
      input: price.input,
      cachedInput: price.cachedInput,
      output: price.output,
    },
    usd,
    thb,
  };
}

/**
 * โหลด cache แล้วดึงซองใหม่ — ล้มทุกทางแล้วยังเหลือ FLOOR
 * เก็บไฟล์ที่เซ็นแล้วลงดิสก์ ไม่เก็บ object ที่ parse แล้ว
 */
export async function refresh(url = `https://cdn.jsdelivr.net/gh/surapas3022/model-catalogue@main/config.${CHANNEL}.json`, cachePath) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return current;
    const text = await res.text();
    if (!tryAdopt(text)) return current;
    if (cachePath) {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, text);
    }
  } catch {
    // เน็ต/CDN ล้ม — ใช้ current (cache หรือ FLOOR) ต่อ
  }
  return current;
}

export async function startCatalogue({
  url,
  cachePath = join(ROOT, ".cache", `catalogue.${CHANNEL}.json`),
  refreshEveryMs = 6 * 60 * 60 * 1000,
} = {}) {
  try {
    tryAdopt(readFileSync(cachePath, "utf8"));
  } catch {
    // ยังไม่มี cache หรือไฟล์เสีย — FLOOR ตอบต่อ
  }
  await refresh(url, cachePath);
  const timer = setInterval(() => {
    refresh(url, cachePath);
  }, refreshEveryMs);
  timer.unref?.();
  return current;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  const configPath = join(ROOT, "config.stable.json");
  try {
    tryAdopt(readFileSync(configPath, "utf8"));
  } catch {
    // ไฟล์ local ใช้ไม่ได้ — เดโมด้วย FLOOR
  }
  const cat = catalogue();
  const resolved = resolveModel(cat, "order-slip-ocr");
  const unknownFeature = resolveModel(cat, "future-feature-from-new-client");
  const cost = calculateCost(cat, resolved?.modelId, {
    inputTokens: 12_000,
    cachedInputTokens: 3_000,
    outputTokens: 800,
  });

  console.log(
    JSON.stringify(
      {
        version: cat.version,
        channel: cat.channel,
        resolved,
        unknownFeature,
        cost,
      },
      null,
      2
    )
  );
}

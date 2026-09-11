#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
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

export const CLIENT_VERSION = 3;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

const publicKey = createPublicKey(CATALOGUE_PUBLIC_KEY);

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
  if (!Array.isArray(catalogue.purposes?.default) || catalogue.purposes.default.length === 0) {
    throw new Error('catalogue.purposes.default is required');
  }

  return catalogue;
}

function firstUsableModelId(catalogue, modelIds, today) {
  for (const modelId of modelIds) {
    const model = catalogue.models?.[modelId];
    if (!model) continue;
    if (isRetired(model, today)) continue;
    return modelId;
  }
  return null;
}

/**
 * เลือก model id ตัวแรกที่ยังไม่ retired สำหรับ purpose
 * ถ้าไม่มี key ของ purpose ใน catalogue ให้ใช้ purposes.default
 */
export function resolveModel(catalogue, purpose, today = todayUtcDate()) {
  const purposes = catalogue.purposes ?? {};
  // Feature ใหม่ที่ catalogue เก่ายังไม่มี key — ตกไป default
  const candidates = Array.isArray(purposes[purpose]) && purposes[purpose].length > 0
    ? purposes[purpose]
    : purposes.default;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`no model candidates for purpose "${purpose}"`);
  }

  const resolved = firstUsableModelId(catalogue, candidates, today);
  if (resolved) {
    return {
      purpose: purposes[purpose] ? purpose : "default",
      requestedPurpose: purpose,
      modelId: resolved,
      model: catalogue.models[resolved],
      fallbackUsed: !purposes[purpose],
    };
  }

  // รายการของ purpose หมดอายุหมดแล้ว — ลอง default อีกครั้งถ้ายังไม่ได้ใช้
  if (purpose !== "default" && purposes[purpose]) {
    const defaultId = firstUsableModelId(catalogue, purposes.default, today);
    if (defaultId) {
      return {
        purpose: "default",
        requestedPurpose: purpose,
        modelId: defaultId,
        model: catalogue.models[defaultId],
        fallbackUsed: true,
      };
    }
  }

  throw new Error(`no usable (non-retired) model for purpose "${purpose}"`);
}

function priceForModel(catalogue, modelId) {
  const model = catalogue.models?.[modelId];
  if (model) {
    return {
      input: model.input,
      cachedInput: model.cachedInput,
      output: model.output,
      usedFallbackPrice: false,
    };
  }
  const fallback = catalogue.fallbackPrice;
  if (!fallback) {
    throw new Error(`unknown model "${modelId}" and catalogue.fallbackPrice is missing`);
  }
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
 */
export function calculateCost(catalogue, modelId, usage = {}) {
  const inputTokens = Number(usage.inputTokens ?? 0);
  const cachedInputTokens = Number(usage.cachedInputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  if ([inputTokens, cachedInputTokens, outputTokens].some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("usage token counts must be finite numbers >= 0");
  }

  const price = priceForModel(catalogue, modelId);
  const usd =
    (inputTokens / TOKENS_PER_PRICE_UNIT) * price.input +
    (cachedInputTokens / TOKENS_PER_PRICE_UNIT) * price.cachedInput +
    (outputTokens / TOKENS_PER_PRICE_UNIT) * price.output;
  const thb = usd * Number(catalogue.usdToThb);

  return {
    modelId,
    priceUnit: catalogue.priceUnit,
    usdToThb: catalogue.usdToThb,
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

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  const configPath = join(ROOT, "config.stable.json");
  const signed = JSON.parse(readFileSync(configPath, "utf8"));
  const catalogue = adopt(signed, 13);
  const resolved = resolveModel(catalogue, "order-slip-ocr");
  const unknownFeature = resolveModel(catalogue, "future-feature-from-new-client");
  const cost = calculateCost(catalogue, resolved.modelId, {
    inputTokens: 12_000,
    cachedInputTokens: 3_000,
    outputTokens: 800,
  });

  console.log(
    JSON.stringify(
      {
        version: catalogue.version,
        channel: catalogue.channel,
        resolved,
        unknownFeature,
        cost,
      },
      null,
      2
    )
  );
}

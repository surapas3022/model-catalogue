#!/usr/bin/env node
import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(ROOT, "catalogue.src.json");
const PRIVATE_KEY_PATH = join(ROOT, "catalogue-private.pem");
const PUBLIC_KEY_PATH = join(ROOT, "catalogue-public.pem");

const args = process.argv.slice(2);
const wantsKeygen = args.includes("keygen") || args.includes("--keygen");
const force = args.includes("--force");
const channelFlagIndex = args.findIndex((arg) => arg === "--channel" || arg === "-c");
const channelOverride =
  channelFlagIndex >= 0 ? args[channelFlagIndex + 1] : undefined;

function fail(message) {
  console.error(`build.mjs: ${message}`);
  process.exit(1);
}

function generateKeys() {
  if ((existsSync(PRIVATE_KEY_PATH) || existsSync(PUBLIC_KEY_PATH)) && !force) {
    fail(
      "key files already exist. Pass --force to overwrite catalogue-private.pem / catalogue-public.pem"
    );
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    PRIVATE_KEY_PATH,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 }
  );
  writeFileSync(
    PUBLIC_KEY_PATH,
    publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o644 }
  );

  console.log(`wrote ${PRIVATE_KEY_PATH}`);
  console.log(`wrote ${PUBLIC_KEY_PATH}`);
  console.log("embed the public key in client.mjs as CATALOGUE_PUBLIC_KEY");
  console.log("store the private key in GitHub Actions secret CATALOGUE_PRIVATE_KEY");
}

function normalizePem(raw) {
  const trimmed = String(raw).trim().replace(/\\n/g, "\n");
  if (!trimmed.includes("BEGIN")) {
    fail("private key is not a PEM document (expected -----BEGIN PRIVATE KEY-----)");
  }
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function loadPrivateKey() {
  const fromEnv = process.env.CATALOGUE_KEY || process.env.CATALOGUE_PRIVATE_KEY;
  if (fromEnv && fromEnv.trim()) {
    return createPrivateKey(normalizePem(fromEnv));
  }
  if (!existsSync(PRIVATE_KEY_PATH)) {
    fail(
      "missing private key. Run `node build.mjs --keygen` or set CATALOGUE_KEY / CATALOGUE_PRIVATE_KEY"
    );
  }
  return createPrivateKey(readFileSync(PRIVATE_KEY_PATH, "utf8"));
}

function assertCatalogue(src) {
  if (typeof src !== "object" || src === null || Array.isArray(src)) {
    fail("catalogue.src.json must be a JSON object");
  }
  for (const field of [
    "version",
    "channel",
    "minClientVersion",
    "publishedAt",
    "usdToThb",
    "priceUnit",
    "models",
    "purposes",
    "fallbackPrice",
  ]) {
    if (!(field in src)) fail(`catalogue.src.json is missing required field "${field}"`);
  }
  if (!Number.isInteger(src.version) || src.version < 1) {
    fail("version must be a positive integer");
  }
  if (!Number.isInteger(src.minClientVersion) || src.minClientVersion < 1) {
    fail("minClientVersion must be a positive integer");
  }
  if (typeof src.usdToThb !== "number" || !(src.usdToThb > 0)) {
    fail("usdToThb must be a positive number");
  }
  if (src.priceUnit !== "1M_tokens") {
    fail('priceUnit must be "1M_tokens"');
  }
  if (typeof src.models !== "object" || src.models === null || Array.isArray(src.models)) {
    fail("models must be an object keyed by model id");
  }
  if (typeof src.purposes !== "object" || src.purposes === null || Array.isArray(src.purposes)) {
    fail("purposes must be an object keyed by purpose id");
  }
  // Client เวอร์ชันใหม่ส่ง purpose ที่ catalogue เก่ายังไม่มี — ต้องมี default เสมอ
  if (!Array.isArray(src.purposes.default) || src.purposes.default.length === 0) {
    fail('purposes.default is required and must be a non-empty model id array');
  }

  for (const [modelId, model] of Object.entries(src.models)) {
    for (const priceField of ["input", "cachedInput", "output"]) {
      if (typeof model?.[priceField] !== "number" || model[priceField] < 0) {
        fail(`models["${modelId}"].${priceField} must be a number >= 0`);
      }
    }
    if (typeof model.vision !== "boolean") {
      fail(`models["${modelId}"].vision must be a boolean`);
    }
    if (!["ga", "deprecated", "preview"].includes(model.status)) {
      fail(`models["${modelId}"].status must be ga | deprecated | preview`);
    }
    if (model.retiresOn !== null && typeof model.retiresOn !== "string") {
      fail(`models["${modelId}"].retiresOn must be null or an ISO date string`);
    }
  }

  for (const field of ["input", "cachedInput", "output"]) {
    if (typeof src.fallbackPrice?.[field] !== "number" || src.fallbackPrice[field] < 0) {
      fail(`fallbackPrice.${field} must be a number >= 0`);
    }
  }

  for (const [purpose, modelIds] of Object.entries(src.purposes)) {
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      fail(`purposes["${purpose}"] must be a non-empty array of model ids`);
    }
    for (const modelId of modelIds) {
      if (!src.models[modelId]) {
        fail(`purposes["${purpose}"] references unknown model "${modelId}"`);
      }
    }
  }
}

function signCatalogue(src, privateKey) {
  // ใช้ JSON.stringify(src) เป็น raw payload ทั้งก้อน — ห้าม pretty-print ก่อนเซ็น
  const payload = JSON.stringify(src);
  const sig = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return { payload, sig };
}

function writeSignedConfig(src, privateKey) {
  const signed = signCatalogue(src, privateKey);
  const outPath = join(ROOT, `config.${src.channel}.json`);
  writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`wrote ${outPath} (version ${src.version}, channel ${src.channel})`);
  return outPath;
}

if (wantsKeygen) {
  generateKeys();
  process.exit(0);
}

if (!existsSync(SRC_PATH)) {
  fail(`missing ${SRC_PATH}`);
}

const src = JSON.parse(readFileSync(SRC_PATH, "utf8"));
assertCatalogue(src);

if (channelOverride) {
  if (!["stable", "canary"].includes(channelOverride)) {
    fail('--channel must be "stable" or "canary"');
  }
  src.channel = channelOverride;
} else if (!["stable", "canary"].includes(src.channel)) {
  fail('channel must be "stable" or "canary"');
}

const privateKey = loadPrivateKey();
writeSignedConfig(src, privateKey);

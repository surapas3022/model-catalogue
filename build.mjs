#!/usr/bin/env node
import { generateKeyPairSync, sign, verify, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(ROOT, "catalogue.src.json");
const SCHEMA_PATH = join(ROOT, "catalogue.schema.json");
const PRIVATE_KEY_PATH = process.env.CATALOGUE_KEY_FILE || join(ROOT, "catalogue-private.pem");
const PUBLIC_KEY_PATH = join(ROOT, "catalogue-public.pem");
const CHANNELS = ["stable", "canary"];

const args = process.argv.slice(2);
const wantsKeygen = args.includes("keygen") || args.includes("--keygen");
const force = args.includes("--force");
const channelFlagIndex = args.findIndex((arg) => arg === "--channel" || arg === "-c");

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
    fail("CATALOGUE_KEY is set but does not look like a PEM document (expected -----BEGIN PRIVATE KEY-----). It carries the key itself, not a path — use CATALOGUE_KEY_FILE for a path.");
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

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "items",
  "minItems",
  "minProperties",
  "minLength",
  "minimum",
  "exclusiveMinimum",
]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const child = (path, key) => (path ? `${path}.${key}` : String(key));

function checkSchema(value, schema, root, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(
        `catalogue.schema.json uses "${keyword}" at ${path || "the root"}, which build.mjs does not implement. Implement it or take it out.`
      );
    }
  }

  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    const target = root.$defs?.[name];
    if (!target) throw new Error(`catalogue.schema.json refers to ${schema.$ref}, which is not defined`);
    return checkSchema(value, target, root, path, errors);
  }

  const here = path || "(root)";
  const actual = typeOf(value);

  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = want.some((w) => w === actual || (w === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${here} is ${actual}, expected ${want.join(" or ")}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${here} is ${JSON.stringify(value)}, expected one of: ${schema.enum.join(", ")}`);
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${here} is ${JSON.stringify(value)}, expected ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${here} is ${value}, expected at least ${schema.minimum}`);
    }
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) {
      errors.push(`${here} is ${value}, expected greater than ${schema.exclusiveMinimum}`);
    }
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${here} is empty`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${here} has ${value.length} items, expected at least ${schema.minItems}`);
    }
    if (schema.items) value.forEach((v, i) => checkSchema(v, schema.items, root, `${here}[${i}]`, errors));
    return;
  }

  if (value && typeof value === "object") {
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) {
      errors.push(`${here} is empty`);
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${child(path, key)} is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) {
        checkSchema(v, sub, root, child(path, key), errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${child(path, key)} is not a field this catalogue has`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        checkSchema(v, schema.additionalProperties, root, child(path, key), errors);
      }
    }
  }
}

function assertMeaning(src, outPath) {
  if (!Number.isInteger(src.version) || src.version < 1) {
    fail("version must be a positive integer");
  }
  if (!Number.isInteger(src.minClientVersion) || src.minClientVersion < 1) {
    fail("minClientVersion must be a positive integer");
  }
  if (typeof src.usdToThb !== "number" || !(src.usdToThb > 0)) {
    fail("usdToThb must be a positive number");
  }
  if (!Array.isArray(src.purposes?.default) || src.purposes.default.length === 0) {
    fail("purposes.default is required");
  }
  if (src.publishedAt != null && Number.isNaN(Date.parse(src.publishedAt))) {
    fail("publishedAt is not a date");
  }

  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(JSON.parse(readFileSync(outPath, "utf8")).payload);
      if (src.version <= prev.version) {
        fail(
          `version ${src.version} is not newer than the published ${prev.version} in ${outPath}. To undo a release, raise the version and put the old content back.`
        );
      }
    } catch {
      console.warn(`build.mjs: could not read a version out of ${outPath}; skipping the monotonic check`);
    }
  }

  for (const [modelId, model] of Object.entries(src.models ?? {})) {
    const price = model?.price;
    if (
      !price ||
      typeof price.input !== "number" ||
      typeof price.cachedInput !== "number" ||
      typeof price.output !== "number"
    ) {
      fail(`models["${modelId}"] has no complete price`);
    }
    if (model?.retiresOn != null && Number.isNaN(Date.parse(model.retiresOn))) {
      fail(`models["${modelId}"].retiresOn is not a date`);
    }
  }

  for (const [purpose, modelIds] of Object.entries(src.purposes ?? {})) {
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      fail(`purposes["${purpose}"] must be a non-empty array of model ids`);
    }
    for (const modelId of modelIds) {
      if (!src.models?.[modelId]) {
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

if (wantsKeygen) {
  generateKeys();
  process.exit(0);
}

if (!existsSync(SRC_PATH)) fail(`missing ${SRC_PATH}`);
if (!existsSync(SCHEMA_PATH)) fail(`missing ${SCHEMA_PATH}`);

const src = JSON.parse(readFileSync(SRC_PATH, "utf8"));

let channel = src.channel;
if (channelFlagIndex >= 0) {
  channel = args[channelFlagIndex + 1];
} else if (args[0] && !args[0].startsWith("-") && args[0] !== "keygen") {
  channel = args[0];
}
if (!CHANNELS.includes(channel)) {
  fail(`unknown channel "${channel}" — expected one of: ${CHANNELS.join(", ")}`);
}
src.channel = channel;

const schemaErrors = [];
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
checkSchema(src, schema, schema, "", schemaErrors);
if (schemaErrors.length) {
  for (const e of schemaErrors) console.error(`build.mjs: ${e}`);
  process.exit(1);
}

const outPath = join(ROOT, `config.${src.channel}.json`);
assertMeaning(src, outPath);

const privateKey = loadPrivateKey();
const signed = signCatalogue(src, privateKey);

if (!existsSync(PUBLIC_KEY_PATH)) fail(`missing ${PUBLIC_KEY_PATH}`);
if (
  !verify(
    null,
    Buffer.from(signed.payload, "utf8"),
    readFileSync(PUBLIC_KEY_PATH, "utf8"),
    Buffer.from(signed.sig, "base64")
  )
) {
  fail("the signature does not verify against catalogue-public.pem — the key pair does not match");
}

writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);
console.log(`wrote ${outPath} (version ${src.version}, channel ${src.channel})`);

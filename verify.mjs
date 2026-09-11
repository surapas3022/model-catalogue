/**
 * Proves the signature works and that build.mjs refuses the mistakes it claims
 * to refuse. Generic hub checks only — not product-specific purpose rules.
 *
 *   node verify.mjs
 */
import { execFileSync } from "node:child_process";
import { verify } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
};

const PUB = readFileSync("catalogue-public.pem", "utf8");
const good = JSON.parse(readFileSync("config.stable.json", "utf8"));

const PRIVATE_PEM = (() => {
  const inline = process.env.CATALOGUE_KEY || process.env.CATALOGUE_PRIVATE_KEY;
  if (inline && inline.trim()) return `${inline.trim().replace(/\\n/g, "\n")}\n`;
  if (existsSync("catalogue-private.pem")) return readFileSync("catalogue-private.pem", "utf8");
  console.error("no private key: put catalogue-private.pem here or set CATALOGUE_KEY.");
  process.exit(1);
})();

console.log("\n1. the signature on what we publish");
check(
  "config.stable.json verifies with the public key",
  verify(null, Buffer.from(good.payload, "utf8"), PUB, Buffer.from(good.sig, "base64"))
);

const tampered = good.payload.replace("gemini-3.7-flash", "gemini-9.9-evil");
check(
  "payload changed by one model name no longer verifies",
  tampered !== good.payload &&
    !verify(null, Buffer.from(tampered, "utf8"), PUB, Buffer.from(good.sig, "base64"))
);

const parsed = JSON.parse(good.payload);
console.log("\n2. what the payload carries");
check("channel is stamped inside the payload", parsed.channel === "stable");
check(
  "every model in every chain exists in models",
  Object.values(parsed.purposes).flat().every((m) => parsed.models[m])
);
check(
  "every model has a nested price",
  Object.values(parsed.models).every(
    (m) => typeof m.price?.input === "number" && typeof m.price?.output === "number"
  )
);
check("purposes.default exists", Array.isArray(parsed.purposes.default) && parsed.purposes.default.length > 0);
check("priceUnit is 1M_tokens", parsed.priceUnit === "1M_tokens");

const dir = mkdtempSync(path.join(tmpdir(), "cat-"));
for (const f of ["build.mjs", "catalogue.schema.json", "catalogue-public.pem"]) {
  copyFileSync(f, path.join(dir, f));
}
writeFileSync(path.join(dir, "catalogue-private.pem"), PRIVATE_PEM, { mode: 0o600 });

const runBuild = (args = [], env = {}) =>
  execFileSync("node", ["build.mjs", ...args], {
    cwd: dir,
    stdio: "pipe",
    env: { ...process.env, ...env },
  });

const messageOf = (e) => (e.stderr?.toString() || "") + (e.stdout?.toString() || "");

const refuses = (name, mutate, expectInMessage) => {
  const src = JSON.parse(readFileSync("catalogue.src.json", "utf8"));
  mutate(src);
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild();
    check(name, false, "build succeeded when it should have refused");
  } catch (e) {
    const msg = messageOf(e);
    check(name, msg.includes(expectInMessage), `message did not mention "${expectInMessage}"`);
  }
};

console.log("\n3. build.mjs refuses what it says it refuses");
refuses(
  "a chain naming a model that does not exist",
  (s) => {
    s.purposes["auto-reply"] = ["does-not-exist"];
  },
  "unknown model"
);
refuses(
  "a model with no price",
  (s) => {
    delete s.models["gemini-3.7-flash"].price;
  },
  "price is required"
);
refuses(
  "no default chain",
  (s) => {
    delete s.purposes.default;
  },
  "default is required"
);
refuses(
  "version zero",
  (s) => {
    s.version = 0;
  },
  "expected at least 1"
);

console.log("\n4. the schema catches the wrong shape");
refuses(
  "a misspelled top-level field",
  (s) => {
    s.usdToTHB = s.usdToThb;
    delete s.usdToThb;
  },
  "not a field this catalogue has"
);
refuses(
  "a status outside the list",
  (s) => {
    s.models["gemini-3.7-flash"].status = "probably-fine";
  },
  "expected one of"
);
refuses(
  "a missing publishedAt",
  (s) => {
    delete s.publishedAt;
  },
  "publishedAt is required"
);
refuses(
  "vision written as a string",
  (s) => {
    s.models["gemini-3.7-flash"].vision = "yes";
  },
  "expected boolean"
);
refuses(
  "a price field that is not a number",
  (s) => {
    s.models["gemini-3.7-flash"].price.input = "0.3";
  },
  "expected number"
);
refuses(
  "flat prices on the model instead of model.price",
  (s) => {
    const p = s.models["gemini-3.7-flash"].price;
    delete s.models["gemini-3.7-flash"].price;
    Object.assign(s.models["gemini-3.7-flash"], p);
  },
  "price is required"
);

console.log("\n5. version only goes up");
{
  const src = JSON.parse(readFileSync("catalogue.src.json", "utf8"));
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  runBuild();
  try {
    runBuild();
    check("republishing the same version is refused", false, "it was allowed");
  } catch (e) {
    check("republishing the same version is refused", messageOf(e).includes("is not newer"));
  }
  src.version += 1;
  writeFileSync(path.join(dir, "catalogue.src.json"), JSON.stringify(src, null, 2));
  let ok = true;
  try {
    runBuild();
  } catch {
    ok = false;
  }
  check("a higher version publishes", ok);
}

console.log("\n6. the channel is a closed list");
{
  copyFileSync("catalogue.src.json", path.join(dir, "catalogue.src.json"));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild(["stabel"]);
    check("a misspelled channel is refused", false, "it was allowed");
  } catch (e) {
    check("a misspelled channel is refused", messageOf(e).includes("unknown channel"));
  }
  check("and no file was written under the misspelled name", !existsSync(path.join(dir, "config.stabel.json")));

  let ok = true;
  try {
    runBuild(["canary"]);
  } catch {
    ok = false;
  }
  const canary = ok && JSON.parse(readFileSync(path.join(dir, "config.canary.json"), "utf8"));
  check(
    "canary still publishes on demand, and says canary inside the payload",
    ok && JSON.parse(canary.payload).channel === "canary"
  );
}

console.log("\n7. the key can come from a secret instead of a file");
{
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  rmSync(path.join(dir, "catalogue-private.pem"), { force: true });
  let ok = true;
  try {
    runBuild([], { CATALOGUE_KEY: PRIVATE_PEM });
  } catch {
    ok = false;
  }
  const signed = ok && JSON.parse(readFileSync(path.join(dir, "config.stable.json"), "utf8"));
  check(
    "CATALOGUE_KEY signs a file that verifies with the published public key",
    ok && verify(null, Buffer.from(signed.payload, "utf8"), PUB, Buffer.from(signed.sig, "base64"))
  );

  rmSync(path.join(dir, "config.stable.json"), { force: true });
  let escapedOk = true;
  try {
    runBuild([], { CATALOGUE_KEY: PRIVATE_PEM.replace(/\n/g, "\\n") });
  } catch {
    escapedOk = false;
  }
  check("a PEM whose newlines were escaped is repaired rather than rejected", escapedOk);

  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild([], { CATALOGUE_KEY: "/some/path/to/a/key.pem" });
    check("a CATALOGUE_KEY that is a path, not a key, is refused", false, "it was allowed");
  } catch (e) {
    check("a CATALOGUE_KEY that is a path, not a key, is refused", messageOf(e).includes("does not look like a PEM"));
  }

  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild([], { CATALOGUE_KEY: "" });
    check("with no key at all, build refuses instead of writing an unsigned file", false, "it was allowed");
  } catch (e) {
    check(
      "with no key at all, build refuses instead of writing an unsigned file",
      messageOf(e).includes("missing private key")
    );
  }
  writeFileSync(path.join(dir, "catalogue-private.pem"), PRIVATE_PEM, { mode: 0o600 });
}

console.log("\n8. the schema cannot quietly stop checking");
{
  const realSchema = readFileSync("catalogue.schema.json", "utf8");
  const withUnknown = JSON.parse(realSchema);
  withUnknown.properties.version.oneOf = [{ type: "integer" }];
  writeFileSync(path.join(dir, "catalogue.schema.json"), JSON.stringify(withUnknown, null, 2));
  copyFileSync("catalogue.src.json", path.join(dir, "catalogue.src.json"));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  try {
    runBuild();
    check("a schema keyword build.mjs does not implement is refused", false, "it was allowed");
  } catch (e) {
    check(
      "a schema keyword build.mjs does not implement is refused",
      messageOf(e).includes("does not implement")
    );
  }
  writeFileSync(path.join(dir, "catalogue.schema.json"), realSchema);
}

console.log("\n9. what is published is what this build produces");
{
  copyFileSync("catalogue.src.json", path.join(dir, "catalogue.src.json"));
  rmSync(path.join(dir, "config.stable.json"), { force: true });
  let ok = true;
  try {
    runBuild();
  } catch {
    ok = false;
  }
  const rebuilt = ok && readFileSync(path.join(dir, "config.stable.json"), "utf8");
  check(
    "config.stable.json is byte-for-byte what building the source produces now",
    rebuilt === readFileSync("config.stable.json", "utf8")
  );
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "all good" : "FAILED"} · ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

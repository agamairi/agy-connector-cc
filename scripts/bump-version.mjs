#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const root = process.cwd();
const targets = [
  [
    "package.json",
    (json) => json,
    (json, version) => {
      json.version = version;
    },
  ],
  [
    "plugins/antigravity/.claude-plugin/plugin.json",
    (json) => json,
    (json, version) => {
      json.version = version;
    },
  ],
  [
    ".claude-plugin/marketplace.json",
    (json) => json,
    (json, version) => {
      json.metadata.version = version;
      json.plugins.find((plugin) => plugin.name === "antigravity").version = version;
    },
  ],
];
const [first, second] = process.argv.slice(2);
const check = first === "--check";
const version = check
  ? (second ?? JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version)
  : first;
if (!version || !semver.test(version))
  throw new Error("Usage: node scripts/bump-version.mjs <semver> | --check [semver]");
const mismatches = [];
for (const [file, , set] of targets) {
  const filePath = path.join(root, file),
    json = JSON.parse(fs.readFileSync(filePath));
  if (check) {
    const copy = JSON.parse(JSON.stringify(json));
    set(copy, version);
    if (JSON.stringify(copy) !== JSON.stringify(json)) mismatches.push(file);
  } else {
    set(json, version);
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
  }
}
if (mismatches.length) throw new Error(`Version metadata is out of sync: ${mismatches.join(", ")}`);
console.log(check ? `All version metadata matches ${version}.` : `Set version metadata to ${version}.`);

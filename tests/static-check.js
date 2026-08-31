"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions.sort(), ["activeTab", "downloads", "notifications"]);
assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*"]);
assert.ok(!manifest.permissions.includes("cookies"));
assert.ok(!manifest.permissions.includes("history"));
assert.ok(manifest.content_scripts.some((entry) => entry.js.includes("utils/subtitle.js") && entry.js.includes("content.js")));

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((entry) => entry.js)
];
for (const file of referencedFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `Manifest references missing file: ${file}`);
}

for (const file of ["background.js", "content.js", "main-world.js", "popup.js", "utils/youtube.js", "utils/subtitle.js"]) {
  new vm.Script(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
}

const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
const popupSource = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
const mainWorldSource = fs.readFileSync(path.join(root, "main-world.js"), "utf8");
assert.match(contentSource, /START_EXPORT/);
assert.match(contentSource, /GET_EXPORT_STATE/);
assert.match(popupSource, /START_EXPORT/);
assert.match(backgroundSource, /chrome\.notifications\.create/);
assert.match(backgroundSource, /chrome\.downloads\.search/);
assert.match(mainWorldSource, /PAmodern_transcript_view/);
assert.match(mainWorldSource, /transcript-segment-view-model/);

console.log("Manifest、权限、资源引用与 JavaScript 语法检查通过。");

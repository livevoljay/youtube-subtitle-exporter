"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main-world.js"), "utf8");
const base = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&variant=timing-optimized";
const proofUrl = `${base}&pot=session-proof&fmt=json3&c=WEB`;
const body = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Complete caption." }] }] });

async function request({ requested = base, entries = [], enabled = false, prepare = false, fail = false } = {}) {
  const requests = [];
  const selections = [];
  const resources = entries.map((name) => ({ name }));
  const previous = enabled ? { languageCode: "ja", vssId: ".ja" } : {};
  const player = {
    getPlayerResponse: () => ({
      videoDetails: { videoId: "abcdefghijk", title: "Test video" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: base, languageCode: "en", kind: "asr", vssId: "a.en", name: { simpleText: "English" }
      }] } }
    }),
    getOption: () => previous,
    loadModule: () => {},
    setOption: (_module, _option, selection) => {
      selections.push(selection);
      if (prepare && selection.vssId === "a.en") resources.push({ name: proofUrl });
    }
  };
  let handler;
  let resolveResponse;
  const completed = new Promise((resolve) => { resolveResponse = resolve; });
  const window = {
    fetch: async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        text: async () => !fail && String(url).includes("pot=session-proof") ? body : "",
        headers: { get: () => "application/json" }
      };
    },
    addEventListener: (_name, listener) => { handler = listener; },
    postMessage: (message) => { resolveResponse(message.payload); }
  };
  vm.runInNewContext(source, {
    window, URL, AbortController, setTimeout, clearTimeout,
    performance: { getEntriesByType: () => resources },
    location: { href: "https://www.youtube.com/watch?v=abcdefghijk", origin: "https://www.youtube.com" },
    document: { getElementById: () => player, querySelector: () => null, querySelectorAll: () => [] }
  });
  handler({ source: window, data: {
    type: "YTSE_REQUEST_CAPTION", requestId: "test", baseUrl: requested,
    allowTranscriptFallback: prepare
  } });
  return { result: await completed, requests, selections, previous };
}

(async () => {
  let run = await request({ entries: [proofUrl, `${base}&fmt=json3`, base] });
  assert.equal(run.result.ok, true);
  assert.equal(run.result.body, body);
  assert.deepEqual(run.requests, [proofUrl], "Prefer the official proof-bearing request over newer empty retries");

  const wrongTracks = [
    proofUrl.replace("abcdefghijk", "lmnopqrstuv"),
    proofUrl.replace("lang=en", "lang=ja"),
    proofUrl.replace("kind=asr", "kind=manual"),
    `${proofUrl}&name=alternative`,
    `${proofUrl}&tlang=zh-Hans`,
    proofUrl.replace("variant=timing-optimized", "variant=other"),
    proofUrl.replace("www.youtube.com", "example.com")
  ];
  run = await request({ entries: wrongTracks });
  assert.equal(run.result.ok, false);
  assert.ok(run.requests.every((url) => !url.includes("pot=")), "Never borrow another video's, track's, or translated request");

  run = await request({ requested: `${base}&tlang=zh-Hans`, entries: [proofUrl] });
  assert.equal(run.result.ok, false, "Original captions must not masquerade as translated captions");

  for (const enabled of [false, true]) {
    run = await request({ prepare: true, enabled });
    assert.equal(run.result.ok, true);
    assert.equal(run.requests[0], proofUrl);
    assert.equal(run.selections[0].vssId, "a.en");
    assert.deepEqual(run.selections.at(-1), run.previous, "Restore the previous caption selection/on-off state");
  }

  run = await request({ requested: "https://example.com/api/timedtext", entries: [proofUrl] });
  assert.equal(run.result.ok, false);
  assert.equal(run.requests.length, 0, "Reject external caption URLs before issuing requests");
  console.log("播放器请求回归检查通过：有效请求优先、视频/语言/轨道隔离、翻译隔离、字幕设置恢复与地址验证。");
})().catch((error) => { console.error(error); process.exitCode = 1; });

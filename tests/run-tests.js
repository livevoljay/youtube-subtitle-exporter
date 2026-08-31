"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const context = vm.createContext({ URL, globalThis: {} });
for (const file of ["utils/youtube.js", "utils/subtitle.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
const YouTube = context.globalThis.SubtitleExporterYouTube;
const Subtitle = context.globalThis.SubtitleExporterSubtitle;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

test("1. 英文人工字幕：JSON3 转换为无时间戳纯文本", () => {
  const input = JSON.stringify({ events: [
    { tStartMs: 1200, segs: [{ utf8: "Hello everyone." }] },
    { tStartMs: 3500, segs: [{ utf8: "Today we're going to talk about AI." }] }
  ] });
  assert.equal(Subtitle.toPlainText(Subtitle.parseSubtitle(input, "application/json")),
    "Hello everyone.\n\nToday we're going to talk about AI.");
});

test("2. 英文自动字幕：滚动增长文本只保留完整句", () => {
  const cues = ["Today", "Today we're", "Today we're talking", "Today we're talking about AI."];
  assert.equal(Subtitle.toPlainText(cues), "Today we're talking about AI.");
});

test("3. 中文字幕：XML、实体与标签正确清洗", () => {
  const input = '<?xml version="1.0"?><transcript><text start="0">你好，&lt;b&gt;世界&lt;/b&gt;！</text><text start="2">欢迎使用。</text></transcript>';
  assert.equal(Subtitle.toPlainText(Subtitle.parseSubtitle(input, "text/xml")), "你好，世界！\n\n欢迎使用。");
});

test("4. 多语言字幕：保留语言代码并区分同语言人工/自动轨道", () => {
  const tracks = YouTube.normalizeTracks([
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en", languageCode: "en", name: { simpleText: "English" } },
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr", languageCode: "en", name: { simpleText: "English" }, kind: "asr", vssId: "a.en" },
    { baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=ja", languageCode: "ja", name: { simpleText: "日本語" } }
  ]);
  assert.equal(tracks.length, 3);
  assert.deepEqual(Array.from(tracks, (item) => item.languageCode), ["en", "en", "ja"]);
  assert.match(tracks[0].label, /人工字幕/);
  assert.match(tracks[1].label, /自动生成/);
});

test("5. 无字幕视频：安全返回空轨道", () => {
  const data = YouTube.extractVideoData({ videoDetails: { videoId: "abcdefghijk", title: "No captions" } }, "abcdefghijk");
  assert.equal(data.tracks.length, 0);
});

test("6. YouTube SPA 地址切换：每次从当前 URL 重新识别 video id", () => {
  assert.equal(YouTube.getVideoId("https://www.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
  assert.equal(YouTube.getVideoId("https://www.youtube.com/watch?v=lmnopqrstuv&list=PL1"), "lmnopqrstuv");
  assert.equal(YouTube.getVideoId("https://www.youtube.com/shorts/ZYXwvutsrqp"), "ZYXwvutsrqp");
  assert.equal(YouTube.getVideoId("https://www.youtube.com/"), null);
});

test("7. 刷新/旧响应：拒绝与当前 video id 不匹配的播放器数据", () => {
  const stale = { videoDetails: { videoId: "abcdefghijk", title: "Old" } };
  assert.equal(YouTube.extractVideoData(stale, "lmnopqrstuv"), null);
});

test("8. 长视频：一万条字幕可完成转换且不丢失首尾", () => {
  const cues = Array.from({ length: 10000 }, (_, index) => `Caption line ${index}.`);
  const text = Subtitle.toPlainText(cues);
  assert.ok(text.startsWith("Caption line 0."));
  assert.ok(text.endsWith("Caption line 9999."));
  assert.equal(text.split("\n\n").length, 10000);
});

test("9. 中文标点与 Unicode 文件名得到保留", () => {
  const filename = YouTube.buildFilename('AI：改变世界？ / 测试', "中文（简体）");
  assert.equal(filename, "AI：改变世界？_测试_中文（简体）.txt");
  const longFilename = YouTube.buildFilename("超长中文标题".repeat(50), "中文（简体）");
  assert.ok(Buffer.byteLength(longFilename, "utf8") <= 224);
});

test("10. 自动字幕重叠：移除长重叠前缀但保留新增内容", () => {
  const cues = [
    "We are going to talk about machine learning",
    "about machine learning and neural networks.",
    "and neural networks.",
    "A genuinely new sentence."
  ];
  assert.equal(Subtitle.toPlainText(cues),
    "We are going to talk about machine learning\n\nand neural networks.\n\nA genuinely new sentence.");
});

test("补充：VTT 时间戳、序号和内联标签被移除", () => {
  const input = "WEBVTT\n\n1\n00:00:01.200 --> 00:00:03.500\n<c>Hello &amp; welcome.</c>\n\n2\n00:00:03.500 --> 00:00:06.000\nSecond line.";
  assert.equal(Subtitle.toPlainText(Subtitle.parseSubtitle(input, "text/vtt")), "Hello & welcome.\n\nSecond line.");
});

test("11. 自动翻译：在动态轨道 URL 上增加目标语言且保留原参数", () => {
  const translated = YouTube.buildTranslationUrl(
    "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&expire=123",
    "zh-Hans"
  );
  const url = new URL(translated);
  assert.equal(url.searchParams.get("v"), "abcdefghijk");
  assert.equal(url.searchParams.get("kind"), "asr");
  assert.equal(url.searchParams.get("tlang"), "zh-Hans");
  assert.equal(YouTube.buildTranslationUrl("https://example.com/caption", "ja"), "");
});

test("12. 保留时间戳：JSON3 时间轴可输出带时间范围的 TXT", () => {
  const input = JSON.stringify({ events: [
    { tStartMs: 1200, dDurationMs: 2300, segs: [{ utf8: "Hello everyone." }] },
    { tStartMs: 3500, dDurationMs: 2500, segs: [{ utf8: "Welcome." }] }
  ] });
  const cues = Subtitle.parseSubtitleTimed(input, "application/json");
  assert.equal(cues[0].startMs, 1200);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(
    Subtitle.renderText(cues, { layout: "lines", includeTimestamps: true }),
    "[00:00:01.200 --> 00:00:03.500] Hello everyone.\n[00:00:03.500 --> 00:00:06.000] Welcome."
  );
});

test("13. TXT 排版：段落空行、每句一行和自然段模式互不混淆", () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: "Hello" },
    { startMs: 1000, endMs: 2000, text: "world." }
  ];
  assert.equal(Subtitle.renderText(cues, { layout: "blocks" }), "Hello\n\nworld.");
  assert.equal(Subtitle.renderText(cues, { layout: "lines" }), "Hello\nworld.");
  assert.equal(Subtitle.renderText(cues, { layout: "paragraph" }), "Hello world.");
  assert.equal(Subtitle.renderText([
    { startMs: 0, endMs: 1000, text: "你好，" },
    { startMs: 1000, endMs: 2000, text: "世界！" }
  ], { layout: "paragraph" }), "你好，世界！");
});

test("14. SRT 与 VTT：生成标准序号和时间轴", () => {
  const cues = [{ startMs: 1200, endMs: 3500, text: "Hello & welcome." }];
  assert.equal(Subtitle.renderSrt(cues), "1\n00:00:01,200 --> 00:00:03,500\nHello & welcome.");
  assert.equal(Subtitle.renderVtt(cues), "WEBVTT\n\n00:00:01.200 --> 00:00:03.500\nHello & welcome.");
});

test("15. JSON：包含视频、语言元数据和结构化字幕段落", () => {
  const output = Subtitle.renderJson(
    [{ startMs: 0, endMs: 1000, text: "你好。" }],
    { video: { id: "abcdefghijk", title: "测试" }, language: { code: "zh-Hans", name: "中文（简体）" } }
  );
  const data = JSON.parse(output);
  assert.equal(data.version, 1);
  assert.equal(data.video.id, "abcdefghijk");
  assert.equal(data.language.code, "zh-Hans");
  assert.equal(data.cues[0].text, "你好。");
});

test("16. 多格式文件名：使用正确扩展名并继续限制 UTF-8 长度", () => {
  for (const extension of ["txt", "srt", "vtt", "json"]) {
    const filename = YouTube.buildFilename("超长中文标题".repeat(50), "中文（简体）", extension);
    assert.ok(filename.endsWith(`.${extension}`));
    assert.ok(Buffer.byteLength(filename, "utf8") <= 224);
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`✗ ${name}\n${error.stack}\n`);
  }
}

if (failures) process.exitCode = 1;
else process.stdout.write(`\n${tests.length} 项测试全部通过。\n`);

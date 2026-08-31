(function initSubtitleUtils(global) {
  "use strict";

  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    lrm: "", rlm: "", hellip: "…", ndash: "–", mdash: "—"
  };

  function decodeEntities(value) {
    return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower[0] === "#") {
        const hex = lower[1] === "x";
        const codePoint = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
        try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match; }
        catch (_error) { return match; }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match;
    });
  }

  function cleanCueText(value) {
    return decodeEntities(String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
      .replace(/\r/g, ""))
      .split("\n")
      .map((line) => line.replace(/[\t\u00A0 ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function parseJson3(input) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if (!data || !Array.isArray(data.events)) return [];
    return data.events.map((event) => {
      if (!event || !Array.isArray(event.segs)) return "";
      return cleanCueText(event.segs.map((seg) => seg && seg.utf8 || "").join(""));
    }).filter(Boolean);
  }

  function parseXml(input) {
    const text = String(input || "");
    const cues = [];
    const pattern = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi;
    let match;
    while ((match = pattern.exec(text))) cues.push(cleanCueText(match[1]));
    return cues.filter(Boolean);
  }

  function parseVttOrSrt(input) {
    const blocks = String(input || "").replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        return trimmed &&
          !/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(trimmed) &&
          !/^\d+$/.test(trimmed) &&
          !/^(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->/.test(trimmed);
      });
      const cue = cleanCueText(lines.join("\n"));
      if (cue) cues.push(cue);
    }
    return cues;
  }

  function parseSubtitle(input, contentType) {
    const text = String(input || "").trim();
    if (!text) return [];
    const type = String(contentType || "").toLowerCase();
    if (type.includes("json") || text[0] === "{") {
      try { return parseJson3(text); }
      catch (_error) { /* Continue with text formats. */ }
    }
    if (type.includes("xml") || /^<\?xml|^<transcript|^<timedtext/i.test(text)) return parseXml(text);
    return parseVttOrSrt(text);
  }

  function normalized(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function overlapLength(previous, current) {
    const a = Array.from(normalized(previous));
    const b = Array.from(normalized(current));
    const max = Math.min(a.length, b.length);
    for (let length = max; length >= 1; length -= 1) {
      if (a.slice(-length).join("") === b.slice(0, length).join("")) return length;
    }
    return 0;
  }

  function isMeaningfulOverlap(value, length) {
    if (length < 2) return false;
    const fragment = Array.from(normalized(value)).slice(0, length).join("");
    const wordCount = fragment.split(/\s+/).filter(Boolean).length;
    const containsCjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(fragment);
    return containsCjk ? length >= 3 : wordCount >= 3 || length >= 14;
  }

  function dedupeCues(rawCues) {
    const output = [];
    for (const raw of Array.isArray(rawCues) ? rawCues : []) {
      const cue = cleanCueText(raw);
      if (!cue) continue;
      const current = normalized(cue);
      const previousCue = output[output.length - 1];
      const previous = normalized(previousCue);

      if (!previous) { output.push(cue); continue; }
      if (current === previous) continue;

      // Automatic captions often grow the same rolling line over several events.
      if (current.startsWith(previous) && current.length > previous.length) {
        output[output.length - 1] = cue;
        continue;
      }
      if (previous.startsWith(current) || previous.includes(current)) continue;

      // Remove only substantial suffix/prefix overlaps, preserving intentional short repeats.
      const overlap = overlapLength(previous, current);
      if (isMeaningfulOverlap(current, overlap)) {
        const remainder = Array.from(current).slice(overlap).join("").trim();
        if (remainder) output.push(remainder);
        continue;
      }

      // Suppress exact echoes close to one another without deleting legitimate later refrains.
      if (output.slice(-3).some((item) => normalized(item) === current)) continue;
      output.push(cue);
    }
    return output;
  }

  function toPlainText(rawCues) {
    return dedupeCues(rawCues).join("\n\n").trim();
  }

  global.SubtitleExporterSubtitle = {
    decodeEntities,
    cleanCueText,
    parseJson3,
    parseXml,
    parseVttOrSrt,
    parseSubtitle,
    dedupeCues,
    toPlainText
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

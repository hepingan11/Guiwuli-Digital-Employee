const crypto = require("node:crypto");

const PADDLE_OPTIONAL_PAYLOAD = {
  useDocOrientationClassify: false,
  useDocUnwarping: false,
  useLayoutDetection: true,
  useChartRecognition: false,
  layoutNms: true,
  layoutMergeBboxesMode: "large",
  repetitionPenalty: 1.2,
  temperature: 0.1,
  topP: 0.8,
  visualize: false,
  prettifyMarkdown: false
};

function hashText(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function paddleOptionalPayload() {
  const payload = { ...PADDLE_OPTIONAL_PAYLOAD };
  if (!payload.useLayoutDetection) payload.promptLabel = "ocr";
  return payload;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function parseImageBox(value) {
  const match = String(value || "").match(/img_in_image_box_(\d+)_(\d+)_(\d+)_(\d+)/i);
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return { x1, y1, x2, y2 };
}

function imageMarker(value) {
  const box = parseImageBox(value);
  if (!box) return "\n[[CAA_IMAGE]]\n";
  return `\n[[CAA_IMAGE:${box.x1},${box.y1},${box.x2},${box.y2}]]\n`;
}

function stripMarkdownAndHtml(value) {
  return decodeHtmlEntities(value)
    .replace(/<div\b[^>]*>\s*<img\b[^>]*>\s*<\/div>/gi, "\n")
    .replace(/<p\b[^>]*>\s*<img\b[^>]*>\s*<\/p>/gi, "\n")
    .replace(/<img\b[^>]*>/gi, "\n")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*]\((?:imgs|images|outputImages)\/[^)]+\)/gi, " ");
}

function cleanTextLine(value) {
  return normalizeText(String(value || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\|+|\|+$/g, ""));
}

function isTimeLikeText(value) {
  const text = normalizeText(value);
  return (
    /^\d{1,2}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?$/.test(text) ||
    /^(昨天|今天|前天)\s*\d{1,2}\s*[:：]\s*\d{2}$/.test(text) ||
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}\s*[:：]\s*\d{2}$/.test(text)
  );
}

function isImageOrMarkupResidue(value) {
  const text = normalizeText(value);
  if (!text) return true;
  if (/^image$/i.test(text)) return true;
  if (/^imgs?\/.+\.(png|jpe?g|webp|gif)$/i.test(text)) return true;
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return true;
  if (/\b(src|alt|width|height|style)=/i.test(text)) return true;
  if (/img_in_image_box/i.test(text)) return true;
  return false;
}

function markdownToTokens(markdown) {
  const marked = decodeHtmlEntities(markdown)
    .replace(/<img\b[^>]*>/gi, (tag) => imageMarker(tag))
    .replace(/!\[[^\]]*]\(([^)]+)\)/g, (_match, src) => imageMarker(src))
    .replace(/\s*(\[\[CAA_IMAGE(?::\d+,\d+,\d+,\d+)?]])\s*/g, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return marked
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const marker = line.match(/^\[\[CAA_IMAGE(?::(\d+),(\d+),(\d+),(\d+))?]]$/);
      if (marker) {
        const box = marker[1]
          ? { x1: Number(marker[1]), y1: Number(marker[2]), x2: Number(marker[3]), y2: Number(marker[4]) }
          : null;
        return { type: "image", box };
      }
      return { type: "text", text: cleanTextLine(stripMarkdownAndHtml(line)) };
    })
    .filter((token) => token.type === "image" || !isImageOrMarkupResidue(token.text));
}

function normalizeBox(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    if (value.length >= 4 && value.every((item) => typeof item === "number")) {
      return { x1: value[0], y1: value[1], x2: value[2], y2: value[3] };
    }

    const points = value
      .filter(Array.isArray)
      .map((point) => ({ x: Number(point[0]), y: Number(point[1]) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

    if (points.length > 0) {
      return {
        x1: Math.min(...points.map((point) => point.x)),
        y1: Math.min(...points.map((point) => point.y)),
        x2: Math.max(...points.map((point) => point.x)),
        y2: Math.max(...points.map((point) => point.y))
      };
    }
  }

  if (typeof value === "object") {
    const x1 = Number(value.x1 ?? value.left ?? value.x ?? value[0]);
    const y1 = Number(value.y1 ?? value.top ?? value.y ?? value[1]);
    const x2 = Number(value.x2 ?? value.right ?? value[2]);
    const y2 = Number(value.y2 ?? value.bottom ?? value[3]);
    if ([x1, y1, x2, y2].every(Number.isFinite)) return { x1, y1, x2, y2 };
  }

  return null;
}

function collectPositionedTextBlocks(node, blocks = [], seen = new WeakSet()) {
  if (!node || typeof node !== "object") return blocks;
  if (seen.has(node)) return blocks;
  seen.add(node);

  const text = node.text ?? node.content ?? node.rec_text ?? node.recText ?? node.transcription ?? node.value;
  const box = normalizeBox(node.bbox ?? node.box ?? node.poly ?? node.points ?? node.coordinate ?? node.coordinates);
  const cleaned = cleanTextLine(text);

  if (cleaned && box && !isImageOrMarkupResidue(cleaned)) {
    blocks.push({ text: cleaned, box });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectPositionedTextBlocks(value, blocks, seen);
  }

  return blocks;
}

function centerX(box) {
  return (Number(box.x1) + Number(box.x2)) / 2;
}

function boxArea(box) {
  if (!box) return 0;
  return Math.max(0, Number(box.x2) - Number(box.x1)) * Math.max(0, Number(box.y2) - Number(box.y1));
}

function intersectionArea(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(Number(a.x1), Number(b.x1));
  const y1 = Math.max(Number(a.y1), Number(b.y1));
  const x2 = Math.min(Number(a.x2), Number(b.x2));
  const y2 = Math.min(Number(a.y2), Number(b.y2));
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function resolveSideThreshold(tokens, positionedBlocks) {
  const textCenters = positionedBlocks
    .filter((block) => block.box && !isTimeLikeText(block.text))
    .map((block) => centerX(block.box))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (textCenters.length >= 2) {
    let bestGap = 0;
    let threshold = null;

    for (let i = 1; i < textCenters.length; i += 1) {
      const gap = textCenters[i] - textCenters[i - 1];
      if (gap > bestGap) {
        bestGap = gap;
        threshold = (textCenters[i] + textCenters[i - 1]) / 2;
      }
    }

    if (threshold !== null && bestGap > 60) return threshold;
  }

  const centers = tokens
    .filter((token) => token.type === "image" && token.box)
    .map((token) => centerX(token.box))
    .filter(Number.isFinite);

  if (centers.length >= 2) {
    const sorted = centers.slice().sort((a, b) => a - b);
    let bestGap = 0;
    let threshold = null;
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > bestGap) {
        bestGap = gap;
        threshold = (sorted[i] + sorted[i - 1]) / 2;
      }
    }
    if (threshold !== null && bestGap > 40) return threshold;
  }

  return Number.POSITIVE_INFINITY;
}

function senderTypeFromBox(box, threshold) {
  if (!box) return "";
  if (!Number.isFinite(threshold)) return "";
  return centerX(box) > threshold ? "agent" : "customer";
}

function adjacentImageSenderType(tokens, index, threshold) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (tokens[i].type === "text") break;
    if (tokens[i].type === "image") return senderTypeFromBox(tokens[i].box, threshold);
  }

  for (let i = index + 1; i < tokens.length; i += 1) {
    if (tokens[i].type === "text") break;
    if (tokens[i].type === "image") return senderTypeFromBox(tokens[i].box, threshold);
  }

  return "";
}

function nearestImageSenderType(tokens, index, threshold) {
  let previous = null;
  let next = null;

  for (let i = index - 1; i >= 0 && index - i <= 4; i -= 1) {
    if (tokens[i].type === "image" && tokens[i].box) {
      previous = {
        distance: index - i,
        senderType: senderTypeFromBox(tokens[i].box, threshold)
      };
      break;
    }
  }

  for (let i = index + 1; i < tokens.length && i - index <= 4; i += 1) {
    if (tokens[i].type === "image" && tokens[i].box) {
      next = {
        distance: i - index,
        senderType: senderTypeFromBox(tokens[i].box, threshold)
      };
      break;
    }
  }

  if (previous?.senderType && next?.senderType) {
    if (previous.distance !== next.distance) {
      return previous.distance < next.distance ? previous.senderType : next.senderType;
    }
    if (previous.senderType === "customer" && next.senderType === "agent") return "unknown";
    return previous.senderType;
  }

  return previous?.senderType || next?.senderType || "";
}

function nearestImageDebug(tokens, index, threshold) {
  const describe = (direction) => {
    const step = direction === "previous" ? -1 : 1;
    for (let i = index + step; i >= 0 && i < tokens.length && Math.abs(i - index) <= 4; i += step) {
      if (tokens[i].type === "image" && tokens[i].box) {
        return {
          distance: Math.abs(i - index),
          center: Math.round(centerX(tokens[i].box)),
          senderType: senderTypeFromBox(tokens[i].box, threshold)
        };
      }
    }
    return null;
  };

  return {
    previous: describe("previous"),
    next: describe("next")
  };
}

function bestPositionedBlockSenderType(text, positionedBlocks, threshold) {
  const normalized = normalizeText(text);
  const matched = positionedBlocks.find((block) => {
    const blockText = normalizeText(block.text);
    return blockText === normalized || blockText.includes(normalized) || normalized.includes(blockText);
  });
  return matched ? senderTypeFromBox(matched.box, threshold) : "";
}

function parseRecognizedEvents(markdown, positionedBlocks = []) {
  const tokens = markdownToTokens(markdown);
  const threshold = resolveSideThreshold(tokens, positionedBlocks);
  const seen = new Set();
  const events = [];
  const imageBoxCount = tokens.filter((token) => token.type === "image" && token.box).length;
  const imageCenters = tokens
    .filter((token) => token.type === "image" && token.box)
    .map((token) => Math.round(centerX(token.box)))
    .sort((a, b) => a - b);
  const textCenters = positionedBlocks
    .filter((block) => block.box && !isTimeLikeText(block.text))
    .map((block) => Math.round(centerX(block.box)))
    .sort((a, b) => a - b);

  tokens.forEach((token, index) => {
    if (token.type !== "text") return;

    const content = cleanTextLine(token.text);
    if (!content || isImageOrMarkupResidue(content)) return;

    const senderType = isTimeLikeText(content)
      ? "time"
      : bestPositionedBlockSenderType(content, positionedBlocks, threshold) ||
        nearestImageSenderType(tokens, index, threshold) ||
        adjacentImageSenderType(tokens, index, threshold) ||
        "unknown";

    const key = `${senderType}:${content.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    events.push({
      content,
      senderType,
      eventType: senderType === "time" ? "time" : "message",
      debug: {
        threshold,
        imageBoxCount,
        imageCenters,
        nearestImage: nearestImageDebug(tokens, index, threshold),
        positionedBlockCount: positionedBlocks.length,
        textCenters
      }
    });
  });

  return events;
}

function splitRecognizedText(text) {
  return parseRecognizedEvents(text)
    .filter((event) => event.senderType !== "time")
    .map((event) => event.content);
}

function buildMessagesFromEvents(events, payload, settings, status) {
  const now = new Date().toISOString();

  return events.map((event, index) => ({
    sourceMessageId: hashText(`${settings.selectedSourceName}|${index}|${event.senderType}|${event.content}`),
    platform: settings.platform || "generic",
    senderType: event.senderType || "unknown",
    senderName: null,
    content: event.content,
    capturedAt: now,
    rawPayload: {
      source: payload?.sourceName || settings.selectedSourceName || "desktop-capture",
      region: settings.chatRegion,
      ocr_provider: settings.ocrProvider,
      ocr_status: status,
      event_type: event.eventType || "message"
      ,
      sender_debug: event.debug || null
    }
  }));
}

function buildMessagesFromLines(lines, payload, settings, status) {
  const events = lines.map((line, index) => ({
    content: line,
    senderType: index === lines.length - 1 ? "customer" : "unknown",
    eventType: "message"
  }));
  return buildMessagesFromEvents(events, payload, settings, status);
}

function dataUrlToFile(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data URL");
  const mimeType = match[1];
  const extension = mimeType.includes("jpeg") ? "jpg" : "png";
  const buffer = Buffer.from(match[2], "base64");
  return {
    blob: new Blob([buffer], { type: mimeType }),
    filename: `desktop-capture.${extension}`
  };
}

async function analyzeWithZhipu(payload, settings) {
  const url = settings.zhipuOcrUrl || "https://open.bigmodel.cn/api/paas/v4/files/ocr";
  const token = settings.zhipuOcrToken || process.env.ZHIPU_OCR_TOKEN || process.env.ZHIPUAI_API_KEY;
  if (!token) throw new Error("Zhipu OCR token is empty. Set it in desktop settings or ZHIPU_OCR_TOKEN.");
  if (!payload?.imageDataUrl) throw new Error("No capture image is available for Zhipu OCR");

  const file = dataUrlToFile(payload.imageDataUrl);
  const form = new FormData();
  form.append("file", file.blob, file.filename);
  form.append("tool_type", settings.zhipuToolType || "hand_write");
  form.append("language_type", settings.zhipuLanguageType || "CHN_ENG");
  form.append("probability", String(settings.zhipuProbability ?? true));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Zhipu OCR failed: ${response.status} ${text}`);

  const result = JSON.parse(text);
  if (result.status !== "succeeded") {
    throw new Error(`Zhipu OCR failed: ${result.message || text}`);
  }

  const events = parseZhipuWordsResult(result.words_result || [], settings, payload);
  const messages = buildMessagesFromEvents(events, payload, settings, "done");

  return {
    provider: "zhipuocr",
    status: "done",
    taskId: result.task_id || null,
    messages,
    blocks: events.map((event) => ({
      id: hashText(`${event.senderType}|${event.content}`),
      text: event.content,
      senderType: event.senderType,
      eventType: event.eventType,
      confidence: event.confidence ?? null,
      bbox: event.box || null
    })),
    capturedAt: new Date().toISOString(),
    note: `Zhipu OCR recognized ${messages.length} events.`
  };
}

function zhipuBox(location) {
  if (!location) return null;
  const left = Number(location.left);
  const top = Number(location.top);
  const width = Number(location.width);
  const height = Number(location.height);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return { x1: left, y1: top, x2: left + width, y2: top + height, width, height };
}

function normalizeWechatBubble(value) {
  const box = normalizeBox(value?.box || value);
  if (!box) return null;
  const senderType = value.senderType === "agent" ? "agent" : "customer";
  return {
    ...value,
    senderType,
    box,
    id: value.id || hashText(`${senderType}|${box.x1}|${box.y1}|${box.x2}|${box.y2}`)
  };
}

function parseWechatBubbleItems(items, bubbles = []) {
  const normalizedBubbles = bubbles
    .map(normalizeWechatBubble)
    .filter(Boolean)
    .sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);

  if (normalizedBubbles.length === 0) return parseWechatZhipuItems(items);

  const usableItems = items
    .filter((item) => item.box)
    .filter((item) => item.text && !isWechatNoiseText(item.text))
    .sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);

  const groups = normalizedBubbles.map((bubble) => ({
    bubble,
    parts: [],
    confidence: null
  }));

  for (const item of usableItems) {
    if (isTimeLikeText(item.text)) {
      groups.push({
        bubble: {
          senderType: "time",
          box: item.box,
          id: hashText(`time|${item.text}|${item.box.y1}`)
        },
        parts: [item.text],
        confidence: item.confidence
      });
      continue;
    }

    let bestGroup = null;
    let bestScore = 0;
    for (const group of groups) {
      if (group.bubble.senderType === "time") continue;
      const overlap = intersectionArea(item.box, group.bubble.box);
      const score = overlap / Math.max(1, boxArea(item.box));
      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    if (bestGroup && bestScore >= 0.18) {
      bestGroup.parts.push(item);
      bestGroup.confidence = bestGroup.confidence ?? item.confidence;
    }
  }

  return groups
    .map((group) => {
      const parts = group.parts
        .slice()
        .sort((a, b) => {
          if (typeof a === "string" || typeof b === "string") return 0;
          return a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1;
        })
        .map((part) => (typeof part === "string" ? part : part.text));
      const content = cleanTextLine(parts.join(""));
      if (!content || isImageOrMarkupResidue(content)) return null;
      const senderType = group.bubble.senderType;
      return {
        content,
        senderType,
        eventType: senderType === "time" ? "time" : "message",
        confidence: group.confidence,
        box: group.bubble.box,
        debug: {
          provider: "zhipuocr",
          platform: "wechat",
          strategy: "bubble-match",
          bubbleId: group.bubble.id,
          bubbleCount: normalizedBubbles.length,
          positionedBlockCount: usableItems.length
        }
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);
}

function resolveZhipuThreshold(items) {
  const centers = items
    .filter((item) => item.box && !isTimeLikeText(item.text))
    .map((item) => centerX(item.box))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (centers.length < 2) return Number.POSITIVE_INFINITY;

  let bestGap = 0;
  let threshold = null;
  for (let i = 1; i < centers.length; i += 1) {
    const gap = centers[i] - centers[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      threshold = (centers[i] + centers[i - 1]) / 2;
    }
  }

  return threshold !== null && bestGap > 60 ? threshold : Number.POSITIVE_INFINITY;
}

function parseZhipuWordsResult(wordsResult, settings = {}, payload = {}) {
  const items = wordsResult
    .map((item) => ({
      text: cleanTextLine(item.words),
      box: zhipuBox(item.location),
      confidence: item.probability ?? item.confidence ?? null
    }))
    .filter((item) => item.text && !isImageOrMarkupResidue(item.text));

  if (settings.platform === "wechat") {
    if (Array.isArray(payload.wechatBubbles) && payload.wechatBubbles.length > 0) {
      return parseWechatBubbleItems(items, payload.wechatBubbles);
    }
    return parseWechatZhipuItems(items);
  }

  const threshold = resolveZhipuThreshold(items);
  const textCenters = items
    .filter((item) => item.box && !isTimeLikeText(item.text))
    .map((item) => Math.round(centerX(item.box)))
    .sort((a, b) => a - b);

  return items.map((item) => {
    const senderType = isTimeLikeText(item.text) ? "time" : senderTypeFromBox(item.box, threshold) || "unknown";
    return {
      content: item.text,
      senderType,
      eventType: senderType === "time" ? "time" : "message",
      confidence: item.confidence,
      box: item.box,
      debug: {
        provider: "zhipuocr",
        threshold,
        textCenters,
        blockCenter: item.box ? Math.round(centerX(item.box)) : null,
        positionedBlockCount: items.length
      }
    };
  });
}

function isWechatNoiseText(text) {
  const value = normalizeText(text);
  if (!value) return true;
  if (/^[·.。,_=一\-—~|\\/:：;；'"“”‘’`]+$/.test(value)) return true;
  if (/^[a-zA-Z0-9]{1,2}$/.test(value)) return true;
  if (/^[^\u4e00-\u9fa5a-zA-Z0-9]{1,4}$/.test(value)) return true;
  return false;
}

function parseWechatZhipuItems(items) {
  const useful = items
    .filter((item) => item.box)
    .filter((item) => !isWechatNoiseText(item.text))
    .sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);

  const textCenters = useful
    .filter((item) => !isTimeLikeText(item.text))
    .map((item) => Math.round(centerX(item.box)))
    .sort((a, b) => a - b);
  const threshold = resolveWechatThreshold(useful);
  const groups = [];

  for (const item of useful) {
    const senderType = isTimeLikeText(item.text) ? "time" : senderTypeFromBox(item.box, threshold) || "unknown";
    const last = groups[groups.length - 1];
    const canMerge =
      last &&
      last.senderType === senderType &&
      senderType !== "time" &&
      Math.abs(item.box.y1 - last.box.y2) <= 16 &&
      Math.abs(centerX(item.box) - centerX(last.box)) <= 80;

    if (canMerge) {
      last.parts.push(item.text);
      last.box = mergeBoxes(last.box, item.box);
      continue;
    }

    groups.push({
      senderType,
      parts: [item.text],
      box: item.box,
      confidence: item.confidence
    });
  }

  return groups.map((group) => ({
    content: group.parts.join(""),
    senderType: group.senderType,
    eventType: group.senderType === "time" ? "time" : "message",
    confidence: group.confidence,
    box: group.box,
    debug: {
      provider: "zhipuocr",
      platform: "wechat",
      threshold,
      textCenters,
      blockCenter: group.box ? Math.round(centerX(group.box)) : null,
      positionedBlockCount: useful.length
    }
  }));
}

function resolveWechatThreshold(items) {
  const centers = items
    .filter((item) => item.box && !isTimeLikeText(item.text))
    .map((item) => centerX(item.box))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (centers.length >= 2) {
    let bestGap = 0;
    let threshold = null;
    for (let i = 1; i < centers.length; i += 1) {
      const gap = centers[i] - centers[i - 1];
      if (gap > bestGap) {
        bestGap = gap;
        threshold = (centers[i] + centers[i - 1]) / 2;
      }
    }
    if (threshold !== null && bestGap > 70) return threshold;
  }

  const xs = items.filter((item) => item.box).flatMap((item) => [item.box.x1, item.box.x2]);
  if (xs.length >= 2) return (Math.min(...xs) + Math.max(...xs)) / 2;
  return Number.POSITIVE_INFINITY;
}

function mergeBoxes(a, b) {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
    width: Math.max(a.x2, b.x2) - Math.min(a.x1, b.x1),
    height: Math.max(a.y2, b.y2) - Math.min(a.y1, b.y1)
  };
}

async function submitPaddleJob(payload, settings) {
  const jobUrl = settings.paddleOcrJobUrl;
  const token = settings.paddleOcrToken || process.env.PADDLEOCR_TOKEN;
  const model = settings.paddleOcrModel || "PaddleOCR-VL-1.6";

  if (!jobUrl) throw new Error("PaddleOCR job URL is empty");
  if (!token) throw new Error("PaddleOCR token is empty. Set it in desktop settings or PADDLEOCR_TOKEN.");

  const headers = {
    Authorization: `bearer ${token}`
  };

  if (payload?.fileUrl) {
    const response = await fetch(jobUrl, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileUrl: payload.fileUrl,
        model,
        optionalPayload: paddleOptionalPayload()
      })
    });
    return readJobId(response);
  }

  if (!payload?.imageDataUrl) {
    throw new Error("No capture image is available for PaddleOCR");
  }

  const file = dataUrlToFile(payload.imageDataUrl);
  const form = new FormData();
  form.append("model", model);
  form.append("optionalPayload", JSON.stringify(paddleOptionalPayload()));
  form.append("file", file.blob, file.filename);

  const response = await fetch(jobUrl, {
    method: "POST",
    headers,
    body: form
  });

  return readJobId(response);
}

async function readJobId(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PaddleOCR submit failed: ${response.status} ${text}`);
  }

  const json = JSON.parse(text);
  const jobId = json?.data?.jobId;
  if (!jobId) throw new Error(`PaddleOCR submit response missing jobId: ${text}`);
  return jobId;
}

async function pollPaddleJob(jobId, settings) {
  const jobUrl = String(settings.paddleOcrJobUrl || "").replace(/\/$/, "");
  const token = settings.paddleOcrToken || process.env.PADDLEOCR_TOKEN;
  const timeoutMs = Number(settings.paddleOcrTimeoutMs) || 120000;
  const intervalMs = Number(settings.paddleOcrPollIntervalMs) || 5000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${jobUrl}/${jobId}`, {
      headers: {
        Authorization: `bearer ${token}`
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`PaddleOCR poll failed: ${response.status} ${text}`);

    const json = JSON.parse(text);
    const data = json?.data || {};
    if (data.state === "done") return data;
    if (data.state === "failed") throw new Error(`PaddleOCR job failed: ${data.errorMsg || "unknown error"}`);

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`PaddleOCR job timed out after ${timeoutMs}ms`);
}

async function fetchPaddleJsonl(resultData) {
  const jsonUrl = resultData?.resultUrl?.jsonUrl;
  if (!jsonUrl) throw new Error("PaddleOCR result jsonUrl is missing");

  const response = await fetch(jsonUrl);
  const text = await response.text();
  if (!response.ok) throw new Error(`PaddleOCR result download failed: ${response.status} ${text}`);

  return text;
}

function parsePaddleJsonl(jsonl) {
  const pages = [];
  const blocks = [];
  const events = [];

  for (const line of String(jsonl || "").split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = JSON.parse(trimmed);
    const results = parsed?.result?.layoutParsingResults || [];

    for (const result of results) {
      const markdown = result?.markdown?.text || "";
      const positionedBlocks = collectPositionedTextBlocks(result?.prunedResult || result);
      const pageEvents = parseRecognizedEvents(markdown, positionedBlocks);

      pages.push(markdown);
      events.push(...pageEvents);

      for (const event of pageEvents) {
        blocks.push({
          id: hashText(`${event.senderType}|${event.content}`),
          text: event.content,
          senderType: event.senderType,
          eventType: event.eventType,
          confidence: null,
          bbox: null
        });
      }
    }
  }

  return {
    text: pages.join("\n\n").trim(),
    blocks,
    events
  };
}

async function analyzeWithPaddle(payload, settings) {
  const jobId = await submitPaddleJob(payload, settings);
  const resultData = await pollPaddleJob(jobId, settings);
  const jsonl = await fetchPaddleJsonl(resultData);
  const parsed = parsePaddleJsonl(jsonl);
  const messages = buildMessagesFromEvents(parsed.events, payload, settings, "done");

  return {
    provider: "paddleocr",
    status: "done",
    jobId,
    messages,
    blocks: parsed.blocks,
    capturedAt: new Date().toISOString(),
    note: `PaddleOCR recognized ${messages.length} events.`
  };
}

function analyzeMock(payload, settings) {
  const sampleText = normalizeText(payload?.sampleText);
  const now = new Date().toISOString();
  if (!sampleText) {
    return {
      provider: settings.ocrProvider,
      status: "empty",
      messages: [],
      blocks: [],
      capturedAt: now,
      note: "OCR engine is not connected yet. Paste sample text to exercise the pipeline."
    };
  }

  const lines = sampleText
    .split(/\n+/)
    .map(normalizeText)
    .filter(Boolean);
  const messages = buildMessagesFromLines(lines, payload, settings, "mocked");

  return {
    provider: settings.ocrProvider,
    status: "mocked",
    messages,
    blocks: messages.map((message, index) => ({
      id: message.sourceMessageId,
      text: message.content,
      senderType: message.senderType,
      eventType: message.rawPayload.event_type,
      confidence: 1,
      bbox: { x: 24, y: 24 + index * 42, width: 640, height: 30 }
    })),
    capturedAt: now,
    note: "Mock OCR parsed pasted lines. Replace this service with PaddleOCR/ONNX inference."
  };
}

async function analyzeFrame(payload, settings) {
  if (settings.ocrProvider === "paddleocr") {
    return analyzeWithPaddle(payload, settings);
  }
  if (settings.ocrProvider === "zhipuocr") {
    return analyzeWithZhipu(payload, settings);
  }
  return analyzeMock(payload, settings);
}

module.exports = {
  analyzeFrame,
  splitRecognizedText
};

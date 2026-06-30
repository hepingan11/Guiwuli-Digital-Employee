import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Clipboard,
  Crosshair,
  Database,
  Eye,
  MessageSquareText,
  Monitor,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import "./styles.css";

const api = window.desktopAgent;

const emptyMemory = {
  messages: [],
  summary: "",
  lastUpdatedAt: null
};

const senderLabels = {
  customer: "CUSTOMER",
  agent: "ME",
  time: "TIME",
  unknown: "UNKNOWN"
};

const WECHAT_CROP_RATIOS = {
  x: 0.325,
  y: 0.068,
  width: 0.655,
  height: 0.81
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取截图"));
    image.src = dataUrl;
  });
}

function clampBox(box, width, height) {
  return {
    x1: Math.max(0, Math.min(width - 1, box.x1)),
    y1: Math.max(0, Math.min(height - 1, box.y1)),
    x2: Math.max(0, Math.min(width, box.x2)),
    y2: Math.max(0, Math.min(height, box.y2))
  };
}

function expandBox(box, padding, width, height) {
  return clampBox({
    x1: box.x1 - padding,
    y1: box.y1 - padding,
    x2: box.x2 + padding,
    y2: box.y2 + padding
  }, width, height);
}

function pixelLooksLikeAgentBubble(r, g, b) {
  return g >= 185 && r >= 95 && r <= 175 && b >= 70 && b <= 165 && g - r >= 45 && g - b >= 45;
}

function pixelLooksLikeCustomerBubble(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return r >= 228 && r <= 246 && g >= 228 && g <= 246 && b >= 228 && b <= 246 && max - min <= 7;
}

function collectComponents(mask, width, height, senderType) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  const stack = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;

    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    stack.push(index);
    visited[index] = 1;

    while (stack.length > 0) {
      const current = stack.pop();
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [current - 1, current + 1, current - width, current + width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nextX = next % width;
        if (Math.abs(nextX - x) > 1) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const fillRatio = count / Math.max(1, boxWidth * boxHeight);
    const centerX = minX + boxWidth / 2;
    const isLikelySide = senderType === "agent" ? centerX > width * 0.32 : centerX < width * 0.66;
    const isLikelyBubble =
      boxWidth >= 28 &&
      boxHeight >= 18 &&
      boxWidth <= width * 0.72 &&
      boxHeight <= height * 0.24 &&
      count >= 180 &&
      fillRatio >= 0.14 &&
      isLikelySide;

    if (isLikelyBubble) {
      components.push({
        senderType,
        box: expandBox({ x1: minX, y1: minY, x2: maxX + 1, y2: maxY + 1 }, 10, width, height)
      });
    }
  }

  return components;
}

function dedupeBubbleBoxes(bubbles) {
  const sorted = bubbles
    .slice()
    .sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);
  const result = [];

  for (const bubble of sorted) {
    const duplicate = result.some((item) => {
      if (item.senderType !== bubble.senderType) return false;
      const x1 = Math.max(item.box.x1, bubble.box.x1);
      const y1 = Math.max(item.box.y1, bubble.box.y1);
      const x2 = Math.min(item.box.x2, bubble.box.x2);
      const y2 = Math.min(item.box.y2, bubble.box.y2);
      const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const area = Math.max(1, (bubble.box.x2 - bubble.box.x1) * (bubble.box.y2 - bubble.box.y1));
      return overlap / area > 0.68;
    });
    if (!duplicate) result.push(bubble);
  }

  return result.map((bubble, index) => ({
    ...bubble,
    id: `wechat-bubble-${index}`
  }));
}

function detectWechatBubbles(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const agentMask = new Uint8Array(width * height);
  const customerMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const index = y * width + x;

      if (pixelLooksLikeAgentBubble(r, g, b)) {
        agentMask[index] = 1;
      } else if (pixelLooksLikeCustomerBubble(r, g, b)) {
        customerMask[index] = 1;
      }
    }
  }

  return dedupeBubbleBoxes([
    ...collectComponents(agentMask, width, height, "agent"),
    ...collectComponents(customerMask, width, height, "customer")
  ]);
}

async function prepareWechatFrame(sourceDataUrl) {
  const image = await loadImage(sourceDataUrl);
  const crop = {
    x: Math.round(image.naturalWidth * WECHAT_CROP_RATIOS.x),
    y: Math.round(image.naturalHeight * WECHAT_CROP_RATIOS.y),
    width: Math.round(image.naturalWidth * WECHAT_CROP_RATIOS.width),
    height: Math.round(image.naturalHeight * WECHAT_CROP_RATIOS.height)
  };
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

  return {
    imageDataUrl: canvas.toDataURL("image/png"),
    wechatBubbles: detectWechatBubbles(canvas),
    crop
  };
}

function App() {
  const [settings, setSettings] = useState(null);
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [sampleText, setSampleText] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [memory, setMemory] = useState(emptyMemory);
  const [suggestion, setSuggestion] = useState("");
  const [conversationId, setConversationId] = useState(null);
  const [status, setStatus] = useState("正在初始化桌面端框架...");
  const [busy, setBusy] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    bootstrap();
    return api.logs?.onLog?.((entry) => {
      const fn = entry.level === "error" ? console.error : console.log;
      fn(`[desktop:${entry.level}] ${entry.message}`, entry.data);
    });
  }, []);

  const latestCustomerMessage = useMemo(() => {
    return [...memory.messages].reverse().find((message) => message.senderType === "customer");
  }, [memory.messages]);

  async function bootstrap() {
    const [loadedSettings, loadedMemory] = await Promise.all([api.settings.get(), api.memory.get()]);
    setSettings(loadedSettings);
    setMemory(loadedMemory);
    await refreshSources(loadedSettings.selectedSourceId);
    setStatus("框架已就绪。下一步接入 PaddleOCR 后即可替换当前模拟识别。");
  }

  async function refreshSources(preferredId = settings?.selectedSourceId) {
    setBusy(true);
    try {
      const items = await api.capture.listSources();
      setSources(items);
      const matched = items.find((item) => item.id === preferredId) || items[0] || null;
      setSelectedSource(matched);
      if (matched && settings?.selectedSourceId !== matched.id) {
        const saved = await api.settings.save({ selectedSourceId: matched.id, selectedSourceName: matched.name });
        setSettings(saved);
      }
    } finally {
      setBusy(false);
    }
  }

  async function updateSettings(patch) {
    const next = await api.settings.save(patch);
    setSettings(next);
    return next;
  }

  async function chooseSource(source) {
    setSelectedSource(source);
    await updateSettings({ selectedSourceId: source.id, selectedSourceName: source.name });
  }

  async function saveConfig() {
    await updateSettings(settings);
    setStatus("设置已保存。");
  }

  async function analyzeCurrentFrame() {
    setBusy(true);
    setSuggestion("");
    try {
      const wechatFrame = settings.platform === "wechat" && selectedSource?.thumbnail
        ? await prepareWechatFrame(selectedSource.thumbnail)
        : null;
      const result = await api.capture.analyzeFrame({
        sourceId: selectedSource?.id,
        sourceName: selectedSource?.name,
        imageDataUrl: wechatFrame?.imageDataUrl || selectedSource?.thumbnail,
        wechatBubbles: wechatFrame?.wechatBubbles || [],
        crop: wechatFrame?.crop || null,
        sampleText
      });
      setAnalysis(result);
      setMemory(result.memory);
      setStatus(result.note || "已完成当前屏识别。");
    } catch (error) {
      setStatus(`识别失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSelectedSourceFrame() {
    const items = await api.capture.listSources();
    setSources(items);
    const matched = items.find((item) => item.id === selectedSource?.id) ||
      items.find((item) => item.name === selectedSource?.name) ||
      items[0] ||
      null;
    setSelectedSource(matched);
    return matched;
  }

  async function scanWechatHistory() {
    if (!selectedSource) {
      setStatus("请先选择微信窗口。");
      return;
    }

    setBusy(true);
    setSuggestion("");
    let latestMemory = memory;
    let noNewRounds = 0;

    try {
      if (settings.platform !== "wechat") {
        await updateSettings({ platform: "wechat" });
      }

      for (let page = 0; page < 5; page += 1) {
        const currentSource = page === 0 ? selectedSource : await refreshSelectedSourceFrame();
        if (!currentSource?.thumbnail) break;

        const wechatFrame = await prepareWechatFrame(currentSource.thumbnail);
        setStatus(`正在识别第 ${page + 1} 屏，检测到 ${wechatFrame.wechatBubbles.length} 个气泡...`);
        const beforeCount = latestMemory.messages.length;
        const result = await api.capture.analyzeFrame({
          sourceId: currentSource.id,
          sourceName: currentSource.name,
          imageDataUrl: wechatFrame.imageDataUrl,
          wechatBubbles: wechatFrame.wechatBubbles,
          crop: wechatFrame.crop,
          sampleText: "",
          scanPage: page + 1
        });

        setAnalysis(result);
        setMemory(result.memory);
        latestMemory = result.memory;
        const addedCount = Math.max(0, result.memory.messages.length - beforeCount);
        noNewRounds = addedCount === 0 ? noNewRounds + 1 : 0;
        setStatus(`第 ${page + 1} 屏完成，新增 ${addedCount} 条，累计 ${result.memory.messages.length} 条。`);

        if (page >= 1 && noNewRounds >= 2) break;
        if (page < 4) {
          await api.wechat.scrollUp({ sourceName: currentSource.name, wheelNotches: 5 });
          await wait(900);
        }
      }

      setStatus(`微信历史扫描完成，共累计 ${latestMemory.messages.length} 条记录。`);
    } catch (error) {
      setStatus(`微信扫描失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendLatestToBackend() {
    if (!latestCustomerMessage) {
      setStatus("没有可发送的客户消息。");
      return;
    }

    setBusy(true);
    try {
      const result = await api.backend.sendMessage({
        ...latestCustomerMessage,
        platform: settings.platform,
        sourceName: selectedSource?.name
      });
      setConversationId(result.conversation.id);
      setStatus(`已上报最新消息，后端会话 #${result.conversation.id}。`);
      await pollSuggestion(result.conversation.id);
    } catch (error) {
      setStatus(`请求后端失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function pollSuggestion(targetConversationId = conversationId) {
    if (!targetConversationId) return;
    setStatus("正在等待 AI 建议...");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = await api.backend.getSuggestion(targetConversationId);
      if (next?.content) {
        setSuggestion(next.content);
        setStatus("建议回复已生成。");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    setStatus("后端还在生成建议，可稍后刷新。");
  }

  async function copySuggestion() {
    if (!suggestion) return;
    await navigator.clipboard.writeText(suggestion);
    setStatus("建议回复已复制。");
  }

  async function clearMemory() {
    const next = await api.memory.reset();
    setMemory(next);
    setAnalysis(null);
    setSuggestion("");
    setConversationId(null);
    setStatus("本地会话记忆已清空。");
  }

  if (!settings) {
    return <div className="loading">正在启动客服副驾...</div>;
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Windows OCR Copilot</p>
          <h1>客服辅助桌面端</h1>
        </div>
        <div className="statusPill">
          <ShieldCheck size={18} />
          <span>默认仅上传 OCR 文本</span>
        </div>
      </section>

      <section className="workspace">
        <aside className="sidebar">
          <PanelTitle icon={<Monitor size={18} />} title="捕获窗口" />
          <button className="primaryAction" onClick={() => refreshSources()} disabled={busy}>
            <RefreshCw size={18} />
            刷新窗口列表
          </button>

          <div className="sourceList">
            {sources.map((source) => (
              <button
                key={source.id}
                className={`sourceItem ${selectedSource?.id === source.id ? "active" : ""}`}
                onClick={() => chooseSource(source)}
                title={source.name}
              >
                <img src={source.thumbnail} alt="" />
                <span>{source.name}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="center">
          <div className="toolHeader">
            <div>
              <PanelTitle icon={<Crosshair size={18} />} title="当前屏识别" />
              <p>{selectedSource?.name || "未选择窗口"}</p>
            </div>
            <button className="ghostButton" onClick={clearMemory}>
              <RotateCcw size={18} />
              清空记忆
            </button>
          </div>

          <div className="captureSurface">
            {selectedSource ? <img src={selectedSource.thumbnail} alt="窗口预览" /> : <div>请选择窗口</div>}
          </div>

          <div className="manualInput">
            <label htmlFor="sampleText">模拟 OCR 文本</label>
            <textarea
              id="sampleText"
              value={sampleText}
              onChange={(event) => setSampleText(event.target.value)}
              placeholder="框架阶段可粘贴聊天文本测试管线。后续这里会替换为真实 PaddleOCR 输出。"
            />
          </div>

          <div className="actions">
            <button className="primaryAction" onClick={analyzeCurrentFrame} disabled={busy}>
              <Eye size={18} />
              识别当前屏
            </button>
            <button className="primaryAction secondary" onClick={scanWechatHistory} disabled={busy || !selectedSource}>
              <RefreshCw size={18} />
              扫描微信历史
            </button>
            <button className="primaryAction accent" onClick={sendLatestToBackend} disabled={busy || !latestCustomerMessage}>
              <Send size={18} />
              生成建议回复
            </button>
          </div>
        </section>

        <aside className="inspector">
          <PanelTitle icon={<Brain size={18} />} title="会话记忆" />
          <div className="memoryStats">
            <Stat label="已识别消息" value={memory.messages.length} />
            <Stat label="识别状态" value={analysis?.status || "ready"} />
          </div>
          <div className="summaryBox">
            {memory.summary || "开始识别后，这里会显示滚动累积的上下文摘要。"}
          </div>

          <div className="sectionHeader">
            <PanelTitle icon={<MessageSquareText size={18} />} title="最近消息" />
            <label className="debugToggle">
              <input
                type="checkbox"
                checked={showDebug}
                onChange={(event) => setShowDebug(event.target.checked)}
              />
              调试
            </label>
          </div>
          <div className="messageList">
            {memory.messages.slice(-8).map((message) => (
              <div className={`messageItem ${message.senderType === "time" ? "timeItem" : ""}`} key={message.sourceMessageId}>
                <span>{senderLabels[message.senderType] || message.senderType}</span>
                <p>{message.content}</p>
                {showDebug && <DebugInfo debug={message.rawPayload?.sender_debug} />}
              </div>
            ))}
            {memory.messages.length === 0 && <div className="emptyState">暂无消息</div>}
          </div>

          <PanelTitle icon={<Sparkles size={18} />} title="建议回复" />
          <div className="suggestionBox">{suggestion || "生成后会显示在这里。"}</div>
          <button className="ghostButton full" onClick={copySuggestion} disabled={!suggestion}>
            <Clipboard size={18} />
            复制建议
          </button>
        </aside>
      </section>

      <section className="settingsBar">
        <label>
          API 地址
          <input
            value={settings.apiBaseUrl}
            onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })}
          />
        </label>
        <label>
          API Key
          <input
            value={settings.apiKey}
            onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
          />
        </label>
        <label>
          平台
          <select value={settings.platform} onChange={(event) => setSettings({ ...settings, platform: event.target.value })}>
            <option value="generic">通用</option>
            <option value="wechat">微信</option>
            <option value="qq">QQ</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>
        <label>
          OCR
          <select value={settings.ocrProvider} onChange={(event) => setSettings({ ...settings, ocrProvider: event.target.value })}>
            <option value="mock">模拟</option>
            <option value="paddleocr">PaddleOCR</option>
            <option value="zhipuocr">Zhipu OCR</option>
            <option value="windows">Windows OCR</option>
          </select>
        </label>
        {settings.ocrProvider === "zhipuocr" ? (
          <label>
            Zhipu OCR Token
            <input
              type="password"
              value={settings.zhipuOcrToken || ""}
              onChange={(event) => setSettings({ ...settings, zhipuOcrToken: event.target.value })}
              placeholder="?????? ZHIPU_OCR_TOKEN"
            />
          </label>
        ) : (
          <label>
            PaddleOCR Token
            <input
              type="password"
              value={settings.paddleOcrToken || ""}
              onChange={(event) => setSettings({ ...settings, paddleOcrToken: event.target.value })}
              placeholder="?????? PADDLEOCR_TOKEN"
            />
          </label>
        )}
        <button className="saveButton" onClick={saveConfig}>
          <Save size={18} />
          保存
        </button>
      </section>

      <footer>
        <Database size={16} />
        <span>{status}</span>
      </footer>
    </main>
  );
}

function PanelTitle({ icon, title }) {
  return (
    <div className="panelTitle">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DebugInfo({ debug }) {
  if (!debug) return <pre className="debugInfo">sender_debug: null</pre>;

  const threshold = Number.isFinite(debug.threshold) ? Math.round(debug.threshold) : String(debug.threshold);
  const centers = Array.isArray(debug.textCenters) ? debug.textCenters.join(", ") : "-";
  const imageCenters = Array.isArray(debug.imageCenters) ? debug.imageCenters.join(", ") : "-";
  const nearestImage = debug.nearestImage ? JSON.stringify(debug.nearestImage) : "-";

  return (
    <pre className="debugInfo">
      {[
        `provider: ${debug.provider ?? "-"}`,
        `platform: ${debug.platform ?? "-"}`,
        `threshold: ${threshold}`,
        `textCenters: ${centers}`,
        `imageCenters: ${imageCenters}`,
        `nearestImage: ${nearestImage}`,
        `blockCenter: ${debug.blockCenter ?? "-"}`,
        `imageBoxCount: ${debug.imageBoxCount ?? "-"}`,
        `positionedBlockCount: ${debug.positionedBlockCount ?? "-"}`
      ].join("\n")}
    </pre>
  );
}

export default App;

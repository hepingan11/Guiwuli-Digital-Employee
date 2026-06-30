const { app, BrowserWindow, desktopCapturer, ipcMain, shell } = require("electron");
const path = require("node:path");
const { loadSettings, saveSettings } = require("./services/settings-store.cjs");
const { analyzeFrame } = require("./services/ocr-service.cjs");
const { mergeMessages, resetMemory, getMemory } = require("./services/conversation-memory.cjs");
const { createApiClient } = require("./services/backend-client.cjs");
const { scrollWechatHistory } = require("./services/wechat-scroll-service.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Customer Assistance Agent",
    backgroundColor: "#f5f1e8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[desktop] failed to load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[desktop] renderer process gone", details);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("settings:get", async () => loadSettings(app.getPath("userData")));

ipcMain.handle("settings:save", async (_event, patch) => saveSettings(app.getPath("userData"), patch));

ipcMain.handle("capture:list-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 1280, height: 720 },
    fetchWindowIcons: true
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon?.toDataURL() || null
  }));
});

ipcMain.handle("capture:analyze-frame", async (_event, payload) => {
  const settings = await loadSettings(app.getPath("userData"));
  sendRendererLog("info", "OCR analyze started", {
    provider: settings.ocrProvider,
    platform: settings.platform,
    sourceName: payload?.sourceName,
    hasImage: Boolean(payload?.imageDataUrl),
    wechatBubbleCount: Array.isArray(payload?.wechatBubbles) ? payload.wechatBubbles.length : 0
  });

  try {
    const analysis = await analyzeFrame(payload, settings);
    const memory = mergeMessages(analysis.messages);
    sendRendererLog("info", "OCR analyze finished", {
      provider: analysis.provider,
      status: analysis.status,
      messageCount: analysis.messages?.length || 0,
      sample: analysis.messages?.slice(0, 3).map((message) => ({
        senderType: message.senderType,
        content: message.content,
        debug: message.rawPayload?.sender_debug
      }))
    });
    return { ...analysis, memory };
  } catch (error) {
    sendRendererLog("error", "OCR analyze failed", {
      message: error.message,
      stack: error.stack
    });
    throw error;
  }
});

ipcMain.handle("memory:get", async () => getMemory());

ipcMain.handle("memory:reset", async () => resetMemory());

ipcMain.handle("wechat:scroll-up", async (_event, payload) => scrollWechatHistory(payload));

ipcMain.handle("backend:send-message", async (_event, payload) => {
  const settings = await loadSettings(app.getPath("userData"));
  const client = createApiClient(settings);
  return client.sendRecognizedMessage(payload);
});

ipcMain.handle("backend:get-suggestion", async (_event, conversationId) => {
  const settings = await loadSettings(app.getPath("userData"));
  const client = createApiClient(settings);
  return client.getSuggestion(conversationId);
});

function sendRendererLog(level, message, data = {}) {
  const entry = {
    level,
    message,
    data,
    time: new Date().toISOString()
  };
  console[level === "error" ? "error" : "log"]("[desktop]", message, data);
  mainWindow?.webContents.send("desktop-log", entry);
}

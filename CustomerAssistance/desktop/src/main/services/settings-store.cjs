const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:8000",
  apiKey: "dev-api-key",
  contextBudget: 262144,
  captureIntervalMs: 2500,
  selectedSourceId: "",
  selectedSourceName: "",
  chatRegion: null,
  privacyMode: "text-only",
  ocrProvider: "mock",
  paddleOcrJobUrl: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
  paddleOcrToken: "",
  paddleOcrModel: "PaddleOCR-VL-1.6",
  paddleOcrPollIntervalMs: 5000,
  paddleOcrTimeoutMs: 120000,
  zhipuOcrUrl: "https://open.bigmodel.cn/api/paas/v4/files/ocr",
  zhipuOcrToken: "",
  zhipuToolType: "hand_write",
  zhipuLanguageType: "CHN_ENG",
  zhipuProbability: true,
  platform: "generic"
};

function settingsPath(userDataPath) {
  return path.join(userDataPath, "desktop-settings.json");
}

async function loadSettings(userDataPath) {
  try {
    const raw = await fs.readFile(settingsPath(userDataPath), "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_SETTINGS;
    throw error;
  }
}

async function saveSettings(userDataPath, patch) {
  const next = { ...(await loadSettings(userDataPath)), ...(patch || {}) };
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(settingsPath(userDataPath), JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings
};

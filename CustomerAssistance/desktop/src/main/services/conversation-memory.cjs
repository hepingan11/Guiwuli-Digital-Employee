const memory = {
  messages: [],
  summary: "",
  lastUpdatedAt: null
};

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mergeMessages(messages = []) {
  const existing = new Set(memory.messages.map((message) => message.sourceMessageId));
  const added = [];

  for (const message of messages) {
    const content = normalizeText(message.content);
    if (!content || existing.has(message.sourceMessageId)) continue;
    const next = { ...message, content };
    memory.messages.push(next);
    existing.add(next.sourceMessageId);
    added.push(next);
  }

  if (added.length > 0) {
    memory.lastUpdatedAt = new Date().toISOString();
    memory.summary = buildSummary(memory.messages);
  }

  return getMemory();
}

function buildSummary(messages) {
  if (messages.length === 0) return "";

  const recent = messages
    .filter((message) => message.senderType !== "time")
    .slice(-8)
    .map((message) => message.content);

  return `已识别 ${messages.length} 条事件。最近上下文：${recent.join(" / ")}`;
}

function getMemory() {
  return {
    messages: [...memory.messages],
    summary: memory.summary,
    lastUpdatedAt: memory.lastUpdatedAt
  };
}

function resetMemory() {
  memory.messages = [];
  memory.summary = "";
  memory.lastUpdatedAt = null;
  return getMemory();
}

module.exports = {
  mergeMessages,
  getMemory,
  resetMemory
};

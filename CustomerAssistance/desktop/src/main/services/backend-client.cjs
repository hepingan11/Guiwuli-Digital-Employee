const crypto = require("node:crypto");

function createApiClient(settings) {
  const baseUrl = String(settings.apiBaseUrl || "").replace(/\/$/, "");
  const apiKey = settings.apiKey || "";

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  async function ensureConversation(payload) {
    const externalId = payload.externalId || crypto
      .createHash("sha1")
      .update(`${payload.platform || "desktop"}|${payload.sourceName || "unknown"}`)
      .digest("hex")
      .slice(0, 20);

    return request("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        external_id: externalId,
        page_url: payload.platform ? `desktop://${payload.platform}` : "desktop://ocr",
        title: payload.sourceName || "Desktop OCR Conversation",
        customer_name: payload.customerName || null
      })
    });
  }

  async function sendRecognizedMessage(payload) {
    if (payload.senderType === "time" || payload.rawPayload?.event_type === "time") {
      throw new Error("Time events are not sent to backend suggestions.");
    }
    if (payload.senderType === "agent") {
      throw new Error("Agent messages are not sent as customer triggers.");
    }

    const conversation = await ensureConversation(payload);
    const message = await request("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: conversation.id,
        sender_type: payload.senderType || "unknown",
        sender_name: payload.senderName || null,
        content: payload.content,
        source: "desktop_ocr",
        source_message_id: payload.sourceMessageId,
        context_budget: Number(settings.contextBudget) || 262144,
        raw_payload: payload.rawPayload || {}
      })
    });

    return { conversation, message };
  }

  async function getSuggestion(conversationId) {
    return request(`/api/conversations/${conversationId}/suggestion`);
  }

  return {
    sendRecognizedMessage,
    getSuggestion
  };
}

module.exports = {
  createApiClient
};

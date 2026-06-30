const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAgent", {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (patch) => ipcRenderer.invoke("settings:save", patch)
  },
  capture: {
    listSources: () => ipcRenderer.invoke("capture:list-sources"),
    analyzeFrame: (payload) => ipcRenderer.invoke("capture:analyze-frame", payload)
  },
  memory: {
    get: () => ipcRenderer.invoke("memory:get"),
    reset: () => ipcRenderer.invoke("memory:reset")
  },
  wechat: {
    scrollUp: (payload) => ipcRenderer.invoke("wechat:scroll-up", payload)
  },
  backend: {
    sendMessage: (payload) => ipcRenderer.invoke("backend:send-message", payload),
    getSuggestion: (conversationId) => ipcRenderer.invoke("backend:get-suggestion", conversationId)
  },
  logs: {
    onLog: (callback) => {
      const listener = (_event, entry) => callback(entry);
      ipcRenderer.on("desktop-log", listener);
      return () => ipcRenderer.removeListener("desktop-log", listener);
    }
  }
});

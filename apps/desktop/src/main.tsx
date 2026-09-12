import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";

/** Show window after first paint to avoid blank WebView flashes on Windows. */
async function showMainWindow() {
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch {
    /* browser / missing ACL — Rust fallback may still show */
  }
}

// Desktop app: never show WebView browser chrome (Print / Refresh / Inspect).
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void showMainWindow();
  });
});

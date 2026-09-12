import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

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

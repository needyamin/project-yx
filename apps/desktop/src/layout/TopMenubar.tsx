import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AboutDialog } from "./AboutDialog";
import "./TopMenubar.css";

export type MenuId = "file" | "edit" | "view" | "run" | "help" | null;

type Props = {
  tier: string;
  busy: boolean;
  canExport: boolean;
  playing: boolean;
  snap: boolean;
  hasSelection: boolean;
  clipLinked: boolean;
  clipMonitorOpen: boolean;
  onImport: () => void;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onRippleDelete: () => void;
  onSplitPlayhead: () => void;
  onToggleLink: () => void;
  onLiftZone: () => void;
  onExtractZone: () => void;
  onAspect: (a: "landscape" | "tiktok") => void;
  onZoomFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleSnap: () => void;
  onToggleClipMonitor: () => void;
  onTogglePlay: () => void;
  onCheckUpdates: () => void;
};

const DOCS = "https://github.com/needyamin/project-yx#readme";
const ISSUES = "https://github.com/needyamin/project-yx/issues";
const CONTACT = "https://project-yx.blogspot.com/#support";

export function TopMenubar({
  tier,
  busy,
  canExport,
  playing,
  snap,
  hasSelection,
  clipLinked,
  clipMonitorOpen,
  onImport,
  onExport,
  onUndo,
  onRedo,
  onDelete,
  onRippleDelete,
  onSplitPlayhead,
  onToggleLink,
  onLiftZone,
  onExtractZone,
  onAspect,
  onZoomFit,
  onZoomIn,
  onZoomOut,
  onToggleSnap,
  onToggleClipMonitor,
  onTogglePlay,
  onCheckUpdates,
}: Props) {
  const [open, setOpen] = useState<MenuId>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [version, setVersion] = useState("…");
  const [whiteGui, setWhiteGui] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.1.0"));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("theme-white", whiteGui);
    return () => document.documentElement.classList.remove("theme-white");
  }, [whiteGui]);

  useEffect(() => {
    if (!fullScreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      void getCurrentWindow()
        .setFullscreen(false)
        .then(() => setFullScreen(false))
        .catch(() => setFullScreen(false));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen]);

  useEffect(() => {
    if (!open && !aboutOpen) return;
    function onDoc() {
      setOpen(null);
      setAboutOpen(false);
    }
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open, aboutOpen]);

  function toggle(id: MenuId) {
    setOpen((cur) => (cur === id ? null : id));
    setAboutOpen(false);
  }

  function item(fn: () => void) {
    return () => {
      setOpen(null);
      fn();
    };
  }

  async function toggleFullScreen() {
    const next = !fullScreen;
    try {
      await getCurrentWindow().setFullscreen(next);
      setFullScreen(next);
    } catch {
      setFullScreen(false);
    }
  }

  async function quitApp() {
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }

  return (
    <header className="topbar">
      <div className="menubar">
        <div className="brand compact">
          <span className="logo">YX</span>
          <strong>Project YX</strong>
          <span className={`pill tier-${tier}`}>{tier}</span>
        </div>

        <Menu label="File" id="file" open={open} onToggle={toggle}>
          <button type="button" role="menuitem" disabled={busy} onClick={item(onImport)}>
            Import…
          </button>
          <button type="button" role="menuitem" disabled={busy || !canExport} onClick={item(onExport)}>
            Export…
          </button>
          <hr className="menu-sep" />
          <button type="button" role="menuitem" onClick={item(() => void quitApp())}>
            Quit
          </button>
        </Menu>

        <Menu label="Edit" id="edit" open={open} onToggle={toggle}>
          <button type="button" role="menuitem" onClick={item(onUndo)}>
            Undo
          </button>
          <button type="button" role="menuitem" onClick={item(onRedo)}>
            Redo
          </button>
          <hr className="menu-sep" />
          <button type="button" role="menuitem" disabled={!hasSelection} onClick={item(onDelete)}>
            Delete
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!hasSelection}
            onClick={item(onRippleDelete)}
          >
            Ripple Delete
          </button>
          <button type="button" role="menuitem" onClick={item(onSplitPlayhead)}>
            Split at Playhead
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!hasSelection}
            onClick={item(onToggleLink)}
          >
            {clipLinked ? "Unlink A/V" : "Link A/V"}
          </button>
          <hr className="menu-sep" />
          <button type="button" role="menuitem" onClick={item(onLiftZone)}>
            Lift Zone
          </button>
          <button type="button" role="menuitem" onClick={item(onExtractZone)}>
            Extract Zone
          </button>
        </Menu>

        <Menu label="View" id="view" open={open} onToggle={toggle}>
          <button type="button" role="menuitem" onClick={item(() => onAspect("landscape"))}>
            Aspect 16:9
          </button>
          <button type="button" role="menuitem" onClick={item(() => onAspect("tiktok"))}>
            Aspect 9:16
          </button>
          <hr className="menu-sep" />
          <button type="button" role="menuitem" onClick={item(onZoomFit)}>
            Fit Timeline
          </button>
          <button type="button" role="menuitem" onClick={item(onZoomIn)}>
            Zoom In
          </button>
          <button type="button" role="menuitem" onClick={item(onZoomOut)}>
            Zoom Out
          </button>
          <hr className="menu-sep" />
          <button type="button" role="menuitem" onClick={item(onToggleSnap)}>
            Snap {snap ? "Off" : "On"}
          </button>
          <button type="button" role="menuitem" onClick={item(onToggleClipMonitor)}>
            {clipMonitorOpen ? "Hide Clip Monitor" : "Show Clip Monitor"}
          </button>
          <hr className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            onClick={item(() => setWhiteGui((v) => !v))}
          >
            {whiteGui ? "Dark Interface" : "White Interface"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={item(() => void toggleFullScreen())}
          >
            {fullScreen ? "Exit Full Screen" : "Full Screen"}
          </button>
        </Menu>

        <Menu label="Run" id="run" open={open} onToggle={toggle}>
          <button type="button" role="menuitem" onClick={item(onTogglePlay)}>
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" role="menuitem" disabled={busy || !canExport} onClick={item(onExport)}>
            Export…
          </button>
        </Menu>

        <Menu label="Help" id="help" open={open} onToggle={toggle}>
          <button
            type="button"
            role="menuitem"
            onClick={item(() => void openUrl(DOCS))}
          >
            Documentation
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={item(() => void openUrl(CONTACT))}
          >
            Contact Us
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={item(() => void openUrl(ISSUES))}
          >
            Report Issue
          </button>
          <hr className="menu-sep" />
          <button type="button" role="menuitem" onClick={item(onCheckUpdates)}>
            Check for Updates…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(null);
              setAboutOpen(true);
            }}
          >
            About Project YX
          </button>
        </Menu>
      </div>

      <div className="top-actions">
        <button type="button" className="ghost-btn" disabled={busy} onClick={onImport}>
          Import
        </button>
        <button
          type="button"
          className="primary-btn"
          disabled={busy || !canExport}
          onClick={onExport}
        >
          Export
        </button>
      </div>

      {aboutOpen && (
        <AboutDialog version={version} onClose={() => setAboutOpen(false)} />
      )}
    </header>
  );
}

function Menu({
  label,
  id,
  open,
  onToggle,
  children,
}: {
  label: string;
  id: Exclude<MenuId, null>;
  open: MenuId;
  onToggle: (id: MenuId) => void;
  children: ReactNode;
}) {
  const isOpen = open === id;
  return (
    <div className="menu-root">
      <button
        type="button"
        className={`menu-btn ${isOpen ? "open" : ""}`}
        onClick={() => onToggle(id)}
      >
        {label}
      </button>
      {isOpen && (
        <div className="menu-dropdown" role="menu" onMouseDown={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  );
}

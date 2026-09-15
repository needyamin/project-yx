import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./AboutDialog.css";

const PROFILE_LINKS = [
  { label: "GitHub", url: "https://github.com/needyamin" },
  { label: "Website", url: "https://needyamin.github.io" },
  { label: "ORCID", url: "https://orcid.org/0009-0009-1184-6005" },
  { label: "Facebook", url: "https://facebook.com/needyaminofficial" },
];

type Props = {
  /** App version string from Tauri (shown in the identity header). */
  version?: string;
  onClose: () => void;
};

export function AboutDialog({ version, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="aboutus-overlay"
      role="dialog"
      aria-label="About Project YX"
      onMouseDown={onClose}
    >
      <div
        className="aboutus-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="aboutus-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>

        <div className="aboutus-identity">
          <span className="aboutus-app-logo">YX</span>
          <div>
            <h2 className="aboutus-app-name">Project YX</h2>
            <p className="aboutus-app-version">
              Version {version || "…"} · Open-source desktop video editor
            </p>
          </div>
        </div>

        <hr className="aboutus-divider" />

        <div className="aboutus-head">
          <img
            className="aboutus-photo"
            src="developer.jpg"
            alt="Md. Yamin Hossain"
            draggable={false}
          />
          <div>
            <p className="aboutus-maintained">Created &amp; maintained by</p>
            <h3 className="aboutus-name">Md. Yamin Hossain</h3>
            <p className="aboutus-role">Senior Software Engineer</p>
            <p className="aboutus-loc">Dhaka, Bangladesh</p>
          </div>
        </div>

        <p className="aboutus-bio">
          Software Engineer focused on scalable systems, infrastructure
          automation, and intuitive user experiences.
        </p>

        <div className="aboutus-section-title">Profile Links</div>
        <div className="aboutus-links">
          {PROFILE_LINKS.map((link) => (
            <button
              key={link.label}
              type="button"
              className="aboutus-link"
              onClick={() => void openUrl(link.url)}
              title={link.url}
            >
              <span className="aboutus-link-label">{link.label}</span>
              <span className="aboutus-link-url">{link.url}</span>
            </button>
          ))}
        </div>

        <p className="aboutus-note">
          This open-source desktop app focuses on simple, reliable media
          editing with a clean user experience. Free forever under GPL-3.0.
        </p>

        <button type="button" className="ghost-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

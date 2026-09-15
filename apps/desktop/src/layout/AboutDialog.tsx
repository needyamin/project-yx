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
  /** App version string from Tauri. */
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
      <div className="aboutus-card" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="aboutus-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>

        {/* Brand banner */}
        <div className="aboutus-banner">
          <span className="aboutus-app-mark">YX</span>
          <span className="aboutus-app-name">Project YX</span>
          <span className="aboutus-app-ver">{version ? `v${version}` : ""}</span>
        </div>

        {/* Developer */}
        <div className="aboutus-profile">
          <img
            className="aboutus-photo"
            src="developer.jpg"
            alt="Md. Yamin Hossain"
            draggable={false}
          />
          <div className="aboutus-id">
            <h2 className="aboutus-name">Md. Yamin Hossain</h2>
            <p className="aboutus-role">
              Senior Software Engineer · Dhaka, Bangladesh
            </p>
          </div>
        </div>

        <p className="aboutus-bio">
          Software Engineer focused on scalable systems, infrastructure
          automation, and intuitive user experiences.
        </p>

        {/* Links */}
        <div className="aboutus-links">
          {PROFILE_LINKS.map((link) => (
            <button
              key={link.label}
              type="button"
              onClick={() => void openUrl(link.url)}
              title={link.url}
            >
              {link.label}
            </button>
          ))}
        </div>

        {/* Company + license */}
        <div className="aboutus-footer">
          <div className="aboutus-company">
            <span className="aboutus-company-label">A product of</span>
            <span className="aboutus-company-name">ANSNEW TECH.</span>
          </div>
          <p className="aboutus-license">Open source under GPL-3.0</p>
        </div>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

type IconProps = {
  size?: number;
  className?: string;
};

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconSelect(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 2.5 L3 12.5 L6.2 9.8 L8 14 L9.6 13.2 L7.8 9 L12 9 Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconRazor(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12.5 L12.5 3" />
      <path d="M10.5 3 L12.5 3 L12.5 5" />
      <path d="M3.5 8.5 L7.5 12.5" />
    </Svg>
  );
}

export function IconSpacer(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4.5 V11.5" />
      <path d="M13.5 4.5 V11.5" />
      <path d="M5 8 H11" />
      <path d="M5 8 L6.5 6.5" />
      <path d="M5 8 L6.5 9.5" />
      <path d="M11 8 L9.5 6.5" />
      <path d="M11 8 L9.5 9.5" />
    </Svg>
  );
}

/** Close / remove space (arrows inward). */
export function IconCloseGap(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4.5 V11.5" />
      <path d="M13.5 4.5 V11.5" />
      <path d="M7.5 8 H4" />
      <path d="M4 8 L5.5 6.5" />
      <path d="M4 8 L5.5 9.5" />
      <path d="M8.5 8 H12" />
      <path d="M12 8 L10.5 6.5" />
      <path d="M12 8 L10.5 9.5" />
    </Svg>
  );
}

/** Pack / fill gaps — clips pulled together. */
export function IconFillGaps(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 5 H6 V11 H2.5 Z" />
      <path d="M10 5 H13.5 V11 H10 Z" />
      <path d="M6.5 8 H9.5" />
      <path d="M9.5 8 L8.3 6.8" />
      <path d="M9.5 8 L8.3 9.2" />
      <path d="M6.5 8 L7.7 6.8" />
      <path d="M6.5 8 L7.7 9.2" />
    </Svg>
  );
}

export function IconSlip(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="11" height="6" rx="1" />
      <path d="M5.5 8 H10.5" />
      <path d="M5.5 8 L6.7 6.8" />
      <path d="M5.5 8 L6.7 9.2" />
      <path d="M10.5 8 L9.3 6.8" />
      <path d="M10.5 8 L9.3 9.2" />
    </Svg>
  );
}

export function IconRipple(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 5 H7.5 V11 H2.5 Z" />
      <path d="M9 5 H13.5 V11 H9" />
      <path d="M7.5 8 H11" />
      <path d="M11 8 L9.8 6.8" />
      <path d="M11 8 L9.8 9.2" />
    </Svg>
  );
}

export function IconSplit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5 V13.5" />
      <path d="M3 5 H6.5" />
      <path d="M9.5 5 H13" />
      <path d="M3 11 H6.5" />
      <path d="M9.5 11 H13" />
    </Svg>
  );
}

export function IconZoomIn(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="3.5" />
      <path d="M9.5 9.5 L13 13" />
      <path d="M7 5.5 V8.5" />
      <path d="M5.5 7 H8.5" />
    </Svg>
  );
}

export function IconZoomOut(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="3.5" />
      <path d="M9.5 9.5 L13 13" />
      <path d="M5.5 7 H8.5" />
    </Svg>
  );
}

export function IconZoomFit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 5.5 V2.5 H5.5" />
      <path d="M10.5 2.5 H13.5 V5.5" />
      <path d="M13.5 10.5 V13.5 H10.5" />
      <path d="M5.5 13.5 H2.5 V10.5" />
      <rect x="5" y="5" width="6" height="6" rx="0.5" />
    </Svg>
  );
}

export function IconMore(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconUndo(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 7.5 H10.5 A3 3 0 0 1 10.5 13.5 H8" />
      <path d="M4.5 7.5 L6.5 5.5" />
      <path d="M4.5 7.5 L6.5 9.5" />
    </Svg>
  );
}

export function IconRedo(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11.5 7.5 H5.5 A3 3 0 0 0 5.5 13.5 H8" />
      <path d="M11.5 7.5 L9.5 5.5" />
      <path d="M11.5 7.5 L9.5 9.5" />
    </Svg>
  );
}

export function IconSnap(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5 V13.5" />
      <path d="M3 5.5 H6" />
      <path d="M10 5.5 H13" />
      <path d="M3 10.5 H6" />
      <path d="M10 10.5 H13" />
    </Svg>
  );
}

export function IconMute(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 6.5 H5.2 L8 4 V12 L5.2 9.5 H3 Z" />
      <path d="M10.5 6 L13.5 10" />
      <path d="M13.5 6 L10.5 10" />
    </Svg>
  );
}

export function IconLock(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="7" width="8" height="6" rx="1" />
      <path d="M5.5 7 V5.5 A2.5 2.5 0 0 1 10.5 5.5 V7" />
    </Svg>
  );
}

export function IconHide(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 8 C4.5 4.5 6.5 3.5 8 3.5 C9.5 3.5 11.5 4.5 13.5 8 C11.5 11.5 9.5 12.5 8 12.5 C6.5 12.5 4.5 11.5 2.5 8 Z" />
      <circle cx="8" cy="8" r="1.6" />
    </Svg>
  );
}

export function IconDelete(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4.5 L12 12.5" />
      <path d="M12 4.5 L4 12.5" />
    </Svg>
  );
}

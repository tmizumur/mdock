import type { ReactNode } from "react";

type IconProps = {
  size?: number;
  className?: string;
};

function ModeIcon({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function ViewModeIcon(props: IconProps) {
  return (
    <ModeIcon {...props}>
      <path d="M2.5 12C5 8 8.3 5.8 12 5.8S19 8 21.5 12c-2.5 4-5.8 6.2-9.5 6.2S5 16 2.5 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </ModeIcon>
  );
}

export function EditModeIcon(props: IconProps) {
  return (
    <ModeIcon {...props}>
      <path d="m3.2 20.8 1.4-5.5L16 3.9a2 2 0 0 1 2.8 0l1.3 1.3a2 2 0 0 1 0 2.8L8.7 19.4Z" />
      <path d="m14 5.9 4.1 4.1" />
    </ModeIcon>
  );
}

export function SplitModeIcon(props: IconProps) {
  return (
    <ModeIcon {...props}>
      <rect x="2" y="4.5" width="20" height="15" rx="2.3" />
      <path d="M12 4.5v15M5.5 10h3M5.5 14h2" />
      <rect x="15.5" y="8" width="3" height="3.5" rx="0.8" />
      <path d="M15.5 15.3h3" />
    </ModeIcon>
  );
}

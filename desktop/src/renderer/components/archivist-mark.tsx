import type { SVGProps } from "react";

export function ArchivistMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <ellipse cx="12" cy="6.5" rx="9" ry="3.5" />
      <ellipse cx="12" cy="6.5" rx="2" ry="0.85" />
      <path d="M3 11.5c0 1.93 4.03 3.5 9 3.5s9-1.57 9-3.5" />
      <path d="M3 17c0 1.93 4.03 3.5 9 3.5s9-1.57 9-3.5" />
      <path d="M3 11.5v1M21 11.5v1M3 17v1M21 17v1" />
    </svg>
  );
}

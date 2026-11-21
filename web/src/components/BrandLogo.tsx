import React from 'react';

interface BrandLogoProps {
  className?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ className = 'w-7 h-7' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 64 64"
    fill="none"
    className={className}
    aria-label="AtlasNode Logo"
  >
    <defs>
      <linearGradient id="an-bg" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#131c2e" />
        <stop offset="100%" stopColor="#090c14" />
      </linearGradient>
      <linearGradient id="an-stroke" x1="12" y1="10" x2="52" y2="54" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#38bdf8" />
        <stop offset="55%" stopColor="#60a5fa" />
        <stop offset="100%" stopColor="#34d399" />
      </linearGradient>
      <linearGradient id="an-border" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
        <stop offset="100%" stopColor="#34d399" stopOpacity="0.22" />
      </linearGradient>
      <radialGradient id="an-glow" cx="32" cy="24" r="24" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.24" />
        <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
      </radialGradient>
    </defs>

    <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#an-bg)" stroke="url(#an-border)" strokeWidth="2" />
    <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#an-glow)" />
    <circle cx="32" cy="34" r="20" stroke="#38bdf8" strokeOpacity="0.16" strokeWidth="1.5" strokeDasharray="3 3" />
    <path
      d="M17.5 46L32 16.5L46.5 46"
      stroke="url(#an-stroke)"
      strokeWidth="3.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M23.5 36.5H40.5" stroke="url(#an-stroke)" strokeWidth="3" strokeLinecap="round" strokeOpacity="0.9" />
    <circle cx="17.5" cy="46" r="4.2" fill="#0c1220" stroke="#38bdf8" strokeWidth="2.4" />
    <circle cx="46.5" cy="46" r="4.2" fill="#0c1220" stroke="#34d399" strokeWidth="2.4" />
    <circle cx="32" cy="16.5" r="5" fill="#38bdf8" />
    <circle cx="32" cy="16.5" r="2" fill="#e0f2fe" />
    <circle cx="32" cy="36.5" r="2.6" fill="#34d399" />
  </svg>
);

import React from 'react';
import campusSunsetImg from '../assets/images/campus_sunset_backdrop_1794638255195.jpg';

interface CampusTwilightArtworkProps {
  variant: 'login' | 'banner';
}

/**
 * Photorealistic sunset educational campus backdrop layer paired with atmospheric
 * midnight-navy directional scrims, warm sunset ambient aura, and crimson ground ribbons.
 */
export const CampusTwilightArtwork: React.FC<CampusTwilightArtworkProps> = ({ variant }) => {
  if (variant === 'banner') {
    return (
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden select-none bg-[#071329]">
        <img
          src={campusSunsetImg}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover object-[56%_48%] opacity-90"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(92deg, rgba(5, 12, 29, 0.94) 0%, rgba(10, 18, 42, 0.82) 38%, rgba(15, 23, 42, 0.28) 68%, rgba(7, 15, 34, 0.84) 100%)',
          }}
        />
      </div>
    );
  }

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden select-none bg-[#050C1D]">
      {/* CSS Fallback & Base Twilight Atmosphere */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 60% 34%, rgba(255, 156, 69, 0.35), transparent 52%), linear-gradient(135deg, #050C1D 0%, #071329 48%, #1C1330 100%)',
        }}
      />

      {/* Photorealistic Sunset Educational Campus Backdrop */}
      <img
        src={campusSunsetImg}
        alt=""
        referrerPolicy="no-referrer"
        className="absolute inset-0 w-full h-full object-cover object-center scale-[1.01]"
      />

      {/* Directional Contrast Scrim: keeps left copy crisp while keeping glass building & sunset luminous */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(95deg, rgba(5, 12, 29, 0.88) 0%, rgba(7, 19, 41, 0.74) 32%, rgba(7, 19, 41, 0.16) 60%, rgba(5, 12, 29, 0.34) 100%)',
        }}
      />

      {/* Top & Bottom Edge Scrims for Header Badges and Footer Legibility */}
      <div
        className="absolute inset-x-0 top-0 h-28"
        style={{
          background: 'linear-gradient(180deg, rgba(5, 12, 29, 0.72) 0%, transparent 100%)',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-32"
        style={{
          background: 'linear-gradient(0deg, rgba(5, 12, 29, 0.92) 0%, rgba(5, 12, 29, 0.45) 55%, transparent 100%)',
        }}
      />

      {/* Sweeping Bottom-Right Neon Crimson Light Waves */}
      <svg
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full opacity-90"
      >
        <defs>
          <linearGradient id="cornerCrimsonSweep" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#9A001B" stopOpacity="0.2" />
            <stop offset="55%" stopColor="#FF1739" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#FF9C45" stopOpacity="0.88" />
          </linearGradient>
        </defs>
        <path
          d="M 880 900 C 1130 845, 1365 765, 1600 660 L 1600 900 Z"
          fill="url(#cornerCrimsonSweep)"
          fillOpacity="0.36"
        />
        <path
          d="M 1030 900 C 1230 860, 1430 795, 1600 725"
          fill="none"
          stroke="#FF1739"
          strokeWidth="4"
          strokeOpacity="0.85"
        />
      </svg>
    </div>
  );
};

import { motion, useReducedMotion } from 'motion/react';
import React from 'react';

/**
 * Light white-and-blush-pink corporate security backdrop with flowing abstract
 * crimson silk ribbons, glossy waves, and subtle right-edge red autumn foliage.
 */
export const ShukraBackgroundRibbons: React.FC = () => {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 overflow-hidden bg-gradient-to-br from-white via-[#FFF5F7] to-[#FFE7EC]"
    >
      {/* Soft radial blush-pink ambient washes */}
      <div
        className="absolute -top-24 right-[10%] w-[52rem] h-[42rem] rounded-full opacity-75 blur-3xl"
        style={{
          background:
            'radial-gradient(circle, rgba(255,214,224,0.85) 0%, rgba(255,240,243,0.45) 48%, transparent 74%)',
        }}
      />
      <div
        className="absolute -bottom-32 right-[-6%] w-[48rem] h-[36rem] rounded-full opacity-70 blur-3xl"
        style={{
          background:
            'radial-gradient(circle, rgba(239,0,27,0.22) 0%, rgba(200,16,46,0.12) 45%, transparent 72%)',
        }}
      />

      {/* Flowing Upper Translucent White/Rose Silk Wave */}
      <svg
        viewBox="0 0 1600 900"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full"
      >
        <defs>
          <linearGradient id="shukraRibbonTop" x1="35%" y1="0%" x2="100%" y2="35%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.88" />
            <stop offset="38%" stopColor="#FFD6DF" stopOpacity="0.65" />
            <stop offset="72%" stopColor="#EF001B" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#C8102E" stopOpacity="0.58" />
          </linearGradient>

          <linearGradient id="shukraRibbonMid" x1="40%" y1="15%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.92" />
            <stop offset="55%" stopColor="#FFE0E7" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#EF001B" stopOpacity="0.22" />
          </linearGradient>

          <linearGradient id="shukraRibbonBottom" x1="42%" y1="88%" x2="100%" y2="62%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.08" />
            <stop offset="32%" stopColor="#EF001B" stopOpacity="0.72" />
            <stop offset="68%" stopColor="#C8102E" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#850012" stopOpacity="0.98" />
          </linearGradient>

          <linearGradient id="shukraRibbonBottomSheen" x1="48%" y1="95%" x2="100%" y2="70%">
            <stop offset="0%" stopColor="#FF5970" stopOpacity="0.15" />
            <stop offset="48%" stopColor="#FF334E" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#9B0015" stopOpacity="0.95" />
          </linearGradient>
        </defs>

        {/* Soft luminous ribbon sweeping from center-top toward right edge */}
        <path
          d="M520 -40 C760 240, 1140 240, 1640 40 L1640 165 C1180 330, 740 320, 440 20 Z"
          fill="url(#shukraRibbonTop)"
        />
        <path
          d="M460 110 C780 -40, 1180 -60, 1640 110 L1640 235 C1220 95, 810 110, 460 265 Z"
          fill="url(#shukraRibbonMid)"
          opacity="0.78"
        />

        {/* Glossy deep crimson silk ribbon sweeping across bottom-right */}
        <path
          d="M560 940 C860 935, 1180 865, 1640 695 L1640 930 L560 940 Z"
          fill="url(#shukraRibbonBottom)"
        />
        <path
          d="M680 940 C980 895, 1270 810, 1640 625 L1640 735 C1290 880, 995 930, 680 940 Z"
          fill="url(#shukraRibbonBottomSheen)"
          opacity="0.78"
        />
      </svg>

      {/* Lightweight GPU-composited ribbon highlight drift */}
      <motion.div
        animate={prefersReducedMotion ? undefined : { opacity: [0.35, 0.6, 0.35], x: [0, 14, 0] }}
        transition={
          prefersReducedMotion
            ? undefined
            : { duration: 9, repeat: Infinity, ease: 'easeInOut' }
        }
        className="absolute -bottom-16 right-8 w-80 h-32 rounded-full bg-[#EF001B]/25 blur-2xl will-change-transform"
      />

      {/* Subtle right-edge autumn crimson foliage silhouette (desktop only, echoing reference) */}
      <svg
        viewBox="0 0 180 340"
        fill="none"
        className="hidden xl:block absolute right-0 top-[18%] w-32 h-72 opacity-85"
      >
        <defs>
          <linearGradient id="autumnLeafGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#EF001B" />
            <stop offset="60%" stopColor="#B8001A" />
            <stop offset="100%" stopColor="#6E0010" />
          </linearGradient>
        </defs>
        <path
          d="M180 70 C150 90, 128 118, 92 142 M180 140 C145 155, 112 178, 72 204 M180 218 C154 228, 128 242, 108 265"
          stroke="#4A0810"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        {/* Crisp stylized maple/autumn leaf clusters */}
        {[
          { cx: 148, cy: 62, r: 16, rot: -25 },
          { cx: 118, cy: 86, r: 14, rot: 12 },
          { cx: 158, cy: 102, r: 18, rot: -10 },
          { cx: 92, cy: 128, r: 15, rot: 28 },
          { cx: 134, cy: 138, r: 19, rot: -18 },
          { cx: 166, cy: 148, r: 16, rot: 8 },
          { cx: 74, cy: 174, r: 13, rot: -32 },
          { cx: 112, cy: 176, r: 17, rot: 14 },
          { cx: 148, cy: 188, r: 18, rot: -14 },
          { cx: 94, cy: 214, r: 15, rot: 22 },
          { cx: 132, cy: 232, r: 16, rot: -8 },
          { cx: 162, cy: 248, r: 17, rot: 16 },
          { cx: 112, cy: 266, r: 13, rot: -20 },
        ].map((leaf, i) => (
          <path
            key={i}
            d={`M ${leaf.cx} ${leaf.cy - leaf.r}
                C ${leaf.cx + leaf.r * 0.7} ${leaf.cy - leaf.r * 0.3}, ${leaf.cx + leaf.r * 0.9} ${leaf.cy + leaf.r * 0.5}, ${leaf.cx} ${leaf.cy + leaf.r}
                C ${leaf.cx - leaf.r * 0.9} ${leaf.cy + leaf.r * 0.5}, ${leaf.cx - leaf.r * 0.7} ${leaf.cy - leaf.r * 0.3}, ${leaf.cx} ${leaf.cy - leaf.r} Z`}
            fill="url(#autumnLeafGrad)"
            opacity={0.78 + (i % 3) * 0.08}
            transform={`rotate(${leaf.rot} ${leaf.cx} ${leaf.cy})`}
          />
        ))}
      </svg>
    </div>
  );
};

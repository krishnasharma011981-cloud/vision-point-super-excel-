import { motion, useReducedMotion } from 'motion/react';
import React from 'react';

interface ShukraShieldEmblemProps {
  className?: string;
}

/**
 * Custom glossy crimson Shield-and-Lock emblem matching the SHUKRA SECURITY
 * portal header identity, with a subtle pulsing crimson glow.
 */
export const ShukraShieldEmblem: React.FC<ShukraShieldEmblemProps> = ({ className = 'w-16 h-16' }) => {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className={`relative inline-flex items-center justify-center ${className}`}>
      {/* Soft pulsing crimson ambient halo */}
      <motion.div
        aria-hidden="true"
        animate={
          prefersReducedMotion
            ? undefined
            : {
                scale: [1, 1.14, 1],
                opacity: [0.32, 0.58, 0.32],
              }
        }
        transition={
          prefersReducedMotion
            ? undefined
            : { duration: 3.4, repeat: Infinity, ease: 'easeInOut' }
        }
        className="pointer-events-none absolute inset-1 rounded-full bg-[#EF001B]/35 blur-xl"
      />

      <motion.svg
        viewBox="0 0 80 88"
        fill="none"
        className="relative z-10 w-full h-full drop-shadow-[0_10px_18px_rgba(200,16,46,0.42)]"
        aria-hidden="true"
        animate={prefersReducedMotion ? undefined : { y: [-1.5, 1.5, -1.5] }}
        transition={
          prefersReducedMotion
            ? undefined
            : { duration: 4.2, repeat: Infinity, ease: 'easeInOut' }
        }
      >
        <defs>
          <linearGradient id="shukraShieldOuter" x1="12" y1="6" x2="68" y2="82" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FF233D" />
            <stop offset="48%" stopColor="#C8102E" />
            <stop offset="100%" stopColor="#850012" />
          </linearGradient>
          <linearGradient id="shukraShieldGloss" x1="16" y1="10" x2="54" y2="48" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Outer crimson shield silhouette */}
        <path
          d="M40 4L71 16.5V41.5C71 61.5 57.6 77.4 40 84C22.4 77.4 9 61.5 9 41.5V16.5L40 4Z"
          fill="url(#shukraShieldOuter)"
          stroke="#9B0015"
          strokeWidth="1.5"
        />

        {/* Crisp inner white shield trim */}
        <path
          d="M40 10.2L65.4 20.4V41.2C65.4 58.1 54.2 71.7 40 77.6C25.8 71.7 14.6 58.1 14.6 41.2V20.4L40 10.2Z"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.92"
          strokeWidth="2.4"
        />

        {/* Top-left glossy specular sheen */}
        <path
          d="M40 10.2L14.6 20.4V41.2C14.6 47.4 16.2 53.3 19.1 58.4C31.5 44.5 46.5 31.5 64.5 23.2L65.4 20.4L40 10.2Z"
          fill="url(#shukraShieldGloss)"
        />

        {/* Crisp white padlock shackle */}
        <path
          d="M31.5 41V34.5C31.5 29.8 35.3 26 40 26C44.7 26 48.5 29.8 48.5 34.5V41"
          stroke="#FFFFFF"
          strokeWidth="4.2"
          strokeLinecap="round"
        />

        {/* Crisp white padlock body */}
        <rect x="27" y="40" width="26" height="21" rx="4.5" fill="#FFFFFF" />

        {/* Keyhole */}
        <circle cx="40" cy="48.5" r="2.7" fill="#B10A24" />
        <path d="M38.8 49.5H41.2L41.8 55.5H38.2L38.8 49.5Z" fill="#B10A24" />
      </motion.svg>
    </div>
  );
};

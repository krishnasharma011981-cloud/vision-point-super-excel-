import { motion, useReducedMotion } from 'motion/react';
import React from 'react';

/**
 * Top-left rounded white pill badge: "POWERED BY SHUKRA INFOTECH."
 * Reconstructed with razor-sharp HTML typography & crimson brand mark.
 */
export const ShukraBrandBadge: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div
    className={`inline-flex items-center gap-3.5 rounded-full bg-white px-5 py-2.5 lg:min-w-[292px] lg:h-[68px] lg:px-6 border border-rose-100 shadow-[0_14px_34px_-6px_rgba(155,0,21,0.24),0_2px_10px_rgba(0,0,0,0.08)] ${className}`}
  >
    {/* Red brand droplet/orbit icon matching reference */}
    <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-full bg-[#EF001B] flex items-center justify-center shrink-0 shadow-[0_4px_14px_rgba(239,0,27,0.48)]">
      <svg viewBox="0 0 24 24" className="w-4 h-4 lg:w-5 lg:h-5 text-white" fill="currentColor" aria-hidden="true">
        <path d="M12.6 2.6c-.3-.5-1-.5-1.3 0C9.4 5.7 6 9.3 6 13.4 6 16.9 8.7 19.8 12 19.8s6-2.9 6-6.4c0-4.1-3.4-7.7-5.4-10.8Zm-.6 14.5c-1.8 0-3.2-1.4-3.2-3.2 0-.6.2-1.2.5-1.8.3.9 1.1 1.5 2 1.5 1.3 0 2.3-1 2.3-2.3 0-.5-.1-.9-.4-1.3 1.2 1 2 2.4 2 3.9 0 1.8-1.4 3.2-3.2 3.2Z" />
      </svg>
    </div>
    <div className="leading-[1.14]">
      <span className="block text-[9.5px] lg:text-[11px] font-bold uppercase tracking-[0.14em] text-[#2B2B2B]">
        POWERED BY
      </span>
      <span className="block text-[13px] lg:text-[17px] font-black tracking-tight text-[#111111]">
        SHUKRA INFOTECH.
      </span>
    </div>
  </div>
);

/**
 * Left 55% cinematic security environment on desktop/laptop.
 * Renders strictly the left <55.6% portrait + SHUKRA SECURITY building + HUD scene
 * from the supplied reference asset so the original portrait identity is 100% preserved
 * while ZERO pixels of the reference's static form ever appear.
 */
export const ShukraHeroScene: React.FC = () => {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none hidden lg:block fixed inset-y-0 left-0 w-[56%] xl:w-[58%] overflow-hidden select-none"
      style={{
        WebkitMaskImage:
          'linear-gradient(to right, #000000 0%, #000000 88%, rgba(0,0,0,0.72) 94%, rgba(0,0,0,0.18) 98%, transparent 100%)',
        maskImage:
          'linear-gradient(to right, #000000 0%, #000000 88%, rgba(0,0,0,0.72) 94%, rgba(0,0,0,0.18) 98%, transparent 100%)',
      }}
    >
      {/*
        Exact left-55.5% crop of the 16:9 reference artwork:
        - Preserves the exact original portrait face, beard, tilak, black hoodie & laptop
        - Preserves the SHUKRA SECURITY glass corporate building & red autumn trees
        - Stops strictly before x=56% so the screenshot's non-interactive login card never enters the DOM view
      */}
      <div className="relative w-full h-full overflow-hidden">
        <img
          src="/assets/aistudio/image_ccbe36e2.png"
          alt="Shukra Security headquarters and security specialist"
          referrerPolicy="no-referrer"
          className="h-full max-w-none object-cover object-left"
          style={{
            width: '179%',
            objectPosition: '0% 50%',
          }}
        />

        {/* Lightweight GPU-composited red HUD pulse behind portrait */}
        <motion.div
          animate={
            prefersReducedMotion
              ? undefined
              : {
                  opacity: [0.22, 0.45, 0.22],
                  scale: [0.99, 1.02, 0.99],
                }
          }
          transition={
            prefersReducedMotion
              ? undefined
              : { duration: 4.6, repeat: Infinity, ease: 'easeInOut' }
          }
          className="absolute left-[22%] top-[34%] w-[44%] aspect-square rounded-full border border-[#EF001B]/35 will-change-transform"
        />

        {/* Subtle rotating outer HUD ring accent */}
        <motion.div
          animate={prefersReducedMotion ? undefined : { rotate: 360 }}
          transition={
            prefersReducedMotion
              ? undefined
              : { duration: 45, repeat: Infinity, ease: 'linear' }
          }
          className="absolute left-[20%] top-[32%] w-[48%] aspect-square rounded-full border border-dashed border-[#FF334E]/25 will-change-transform"
        />
      </div>
    </div>
  );
};

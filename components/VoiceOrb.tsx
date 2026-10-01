"use client";

import { motion, useReducedMotion } from "motion/react";

interface VoiceOrbProps {
  status: string;
  micLevel: number;
  label: string;
  detail: string;
}

const BAR_SHAPE = [0.38, 0.64, 0.9, 0.58, 0.78, 0.46, 0.68, 0.34, 0.56];

export function VoiceOrb({ status, micLevel, label, detail }: VoiceOrbProps) {
  const reduceMotion = useReducedMotion();
  const isLive = status === "listening" || status === "speaking";
  const intensity = Math.max(0.08, Math.min(1, micLevel));

  return (
    <div className={`voice-orb voice-orb--${status}`} aria-hidden="true">
      <motion.div
        className="voice-orb__halo voice-orb__halo--outer"
        animate={
          reduceMotion
            ? undefined
            : {
                scale: isLive ? [1, 1.055 + intensity * 0.035, 1] : [1, 1.02, 1],
                opacity: isLive ? [0.3, 0.58, 0.3] : [0.18, 0.28, 0.18],
              }
        }
        transition={{ duration: isLive ? 2.4 : 5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="voice-orb__halo voice-orb__halo--inner"
        animate={
          reduceMotion
            ? undefined
            : {
                rotate: [0, 360],
                scale: status === "analyzing" ? [0.98, 1.04, 0.98] : 1,
              }
        }
        transition={{
          rotate: { duration: 18, repeat: Infinity, ease: "linear" },
          scale: { duration: 1.8, repeat: Infinity, ease: "easeInOut" },
        }}
      />
      <div className="voice-orb__core">
        <div className="voice-orb__grain" />
        <div className="voice-orb__bars">
          {BAR_SHAPE.map((height, index) => (
            <motion.span
              // The visualizer is decorative and deliberately deterministic before mic access.
              key={index}
              animate={
                reduceMotion
                  ? { scaleY: height }
                  : {
                      scaleY: isLive
                        ? [height * 0.55, Math.min(1.4, height + intensity * 0.8), height * 0.55]
                        : [height * 0.45, height * 0.62, height * 0.45],
                    }
              }
              transition={{
                duration: 0.72 + index * 0.055,
                repeat: Infinity,
                ease: "easeInOut",
                delay: index * -0.08,
              }}
            />
          ))}
        </div>
        <div className="voice-orb__copy">
          <span>{label}</span>
          <small>{detail}</small>
        </div>
      </div>
    </div>
  );
}

'use client';

import createGlobe, { type Globe } from 'cobe';
import { useEffect, useRef } from 'react';

const GLOBE_SIZE = 188;
const GLOBE_OPTIONS = {
  width: GLOBE_SIZE * 2,
  height: GLOBE_SIZE * 2,
  phi: 0,
  theta: 0.22,
  mapSamples: 9000,
  mapBrightness: 3.2,
  baseColor: [0.06, 0.2, 0.34] as [number, number, number],
  markerColor: [0.1, 0.48, 0.95] as [number, number, number],
  glowColor: [0.02, 0.11, 0.19] as [number, number, number],
  diffuse: 0.95,
  devicePixelRatio: 2,
  dark: 0.8,
  scale: 0.9,
  offset: [0, 0.05] as [number, number],
};

export function CobeGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let globe: Globe | null = null;
    let frame = 0;
    let visible = false;
    let width = 0;
    let lastDraw = 0;
    let phi = -0.45;

    const destroyGlobe = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      globe?.destroy();
      globe = null;
    };

    const draw = (time: number) => {
      if (!visible || !globe) return;
      if (motionPreference.matches) return;
      if (time - lastDraw >= 80) {
        phi += 0.0018;
        globe.update({ phi });
        lastDraw = time;
      }
      frame = requestAnimationFrame(draw);
    };

    const create = () => {
      destroyGlobe();
      if (!visible || width < 1) return;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${width}px`;
      try {
        globe = createGlobe(canvas, {
          ...GLOBE_OPTIONS,
          width: Math.round(width * pixelRatio),
          height: Math.round(width * pixelRatio),
          devicePixelRatio: pixelRatio,
          phi,
        });
        if (!motionPreference.matches) frame = requestAnimationFrame(draw);
      } catch {
        // Keep the surrounding form usable on browsers without WebGL support.
        canvas.hidden = true;
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? 0);
      if (nextWidth && nextWidth !== width) {
        width = nextWidth;
        create();
      }
    });
    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) create();
      else destroyGlobe();
    }, { rootMargin: '80px' });
    intersectionObserver.observe(container);

    const onMotionChange = () => create();
    motionPreference.addEventListener('change', onMotionChange);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      motionPreference.removeEventListener('change', onMotionChange);
      destroyGlobe();
    };
  }, []);

  return <div className="cg-globe-wrap" ref={containerRef} aria-hidden="true">
    <canvas className="cg-globe-canvas" ref={canvasRef} width={GLOBE_SIZE * 2} height={GLOBE_SIZE * 2} />
  </div>;
}

"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * A wall clock that ticks at display rate while it has something to show.
 *
 * The page as a whole re-renders once a second, which is right for tables and counters but
 * reads as a stutter on anything that moves continuously — a playhead crossing a step, a
 * trace scrolling. This clock drives only the component that asks for it, and only while
 * that component is running, on screen and in a visible tab, and the viewer has not asked
 * for reduced motion. Otherwise it falls back to the page's own clock.
 *
 * Frames are throttled to `fps`: a training console gains nothing from 120 Hz, and a lower
 * rate leaves the main thread to the rest of the page.
 */
export function useFrameClock(
  active: boolean,
  fallbackNow: number,
  target: RefObject<Element | null>,
  fps = 30,
): number {
  const [now, setNow] = useState(fallbackNow);
  const [onScreen, setOnScreen] = useState(true);
  const [reduced, setReduced] = useState(false);
  const last = useRef(0);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const element = target.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "120px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);

  const animating = active && onScreen && !reduced;

  useEffect(() => {
    if (!animating) return;
    let frame = 0;
    const interval = 1000 / fps;
    const loop = (time: number) => {
      if (document.visibilityState === "visible" && time - last.current >= interval) {
        last.current = time;
        setNow(Date.now());
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [animating, fps]);

  // When not animating, follow the page clock so paused and off-screen states stay exact.
  return animating ? Math.max(now, fallbackNow) : fallbackNow;
}

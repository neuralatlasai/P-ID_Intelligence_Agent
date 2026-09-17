"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll-following for a streaming transcript.
 *
 * The rule the product needs is simple to state and easy to get wrong: follow the stream
 * while the user is at the bottom, and stop the instant they scroll up to read something.
 * A transcript that yanks itself back down while an engineer is reading an earlier
 * citation is actively hostile.
 *
 * Following is therefore a mode, not an event. It is switched off when the user scrolls
 * away from the bottom and back on only when they return there or press the explicit
 * control. Programmatic scrolls are marked so they do not switch the mode off themselves.
 */

/** Distance from the bottom, in pixels, still counted as "at the bottom". */
const BOTTOM_THRESHOLD = 96;

export interface UseAutoScrollResult<T extends HTMLElement> {
  readonly containerRef: React.RefObject<T | null>;
  /** True while the view is following new content. */
  readonly following: boolean;
  /** True when there is content below the viewport, so a jump control is warranted. */
  readonly canJump: boolean;
  /** Scroll to the latest content and resume following. */
  readonly jumpToLatest: () => void;
  /** Called by the owner when content grows, so the view can follow if it is following. */
  readonly onContentChange: () => void;
}

export function useAutoScroll<T extends HTMLElement>(
  dependencies: readonly unknown[] = [],
): UseAutoScrollResult<T> {
  const containerRef = useRef<T | null>(null);
  const [following, setFollowing] = useState(true);
  const [canJump, setCanJump] = useState(false);

  // Set while a scroll this hook initiated is in flight, so the resulting scroll event is
  // not mistaken for the user scrolling away.
  const programmaticRef = useRef(false);

  const isAtBottom = useCallback((element: T): boolean => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distance <= BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior): void => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    programmaticRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior });
    // Release the guard after the scroll has settled. A frame is enough for "auto" and
    // generous enough for "smooth" not to be misread part-way through.
    window.setTimeout(() => {
      programmaticRef.current = false;
    }, 120);
  }, []);

  const onContentChange = useCallback((): void => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    if (following) {
      scrollToBottom("auto");
    }
    setCanJump(!isAtBottom(element));
  }, [following, isAtBottom, scrollToBottom]);

  const jumpToLatest = useCallback((): void => {
    setFollowing(true);
    scrollToBottom("smooth");
    setCanJump(false);
  }, [scrollToBottom]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const onScroll = (): void => {
      if (programmaticRef.current) {
        return;
      }
      const atBottom = isAtBottom(element);
      setFollowing(atBottom);
      setCanJump(!atBottom);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [isAtBottom]);

  // Follow content growth while following is on.
  useEffect(() => {
    onContentChange();
    // The dependency list is supplied by the caller: it is whatever changes when content
    // grows, typically the streamed text and the turn count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return { containerRef, following, canJump, jumpToLatest, onContentChange };
}

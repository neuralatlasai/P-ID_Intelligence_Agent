"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/Button";
import { SendIcon, StopIcon } from "@/components/ui/icons";

import styles from "./FollowUpComposer.module.css";

export interface FollowUpComposerProps {
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
  /** True while this session has a run in flight. */
  readonly busy: boolean;
  /** Set when the backend cannot serve a run, with the reason to show. */
  readonly blockedReason?: string | null;
  readonly placeholder?: string;
}

/** Imperative operations the shell performs on the composer. */
export interface ComposerHandle {
  /** Replace the draft and focus the field, with the caret at the end. */
  readonly setDraft: (text: string) => void;
  readonly focus: () => void;
}

/** Maximum height before the field scrolls instead of growing. */
const MAX_HEIGHT_PX = 200;

/**
 * The question composer.
 *
 * Enter submits and Shift+Enter inserts a newline. The field grows to a bound and then
 * scrolls, so a long question never pushes the conversation off screen.
 *
 * While a run is active the send control becomes Stop and the field is locked. One run per
 * session is a backend guarantee; the composer reflects it rather than letting the user
 * queue a request that would be serialised anyway.
 *
 * The draft lives here rather than in the shell, so a keystroke re-renders one small
 * component instead of the whole transcript. Seeding it — from an example prompt or after a
 * failure — is therefore imperative, through a ref: passing the text down as a prop would
 * mean an effect copying a prop into state, and the extra render it causes is exactly what
 * keeping the draft local is meant to avoid.
 */
export const FollowUpComposer = forwardRef<ComposerHandle, FollowUpComposerProps>(
  function FollowUpComposer(
    {
      onSubmit,
      onCancel,
      busy,
      blockedReason,
      placeholder = "Ask a follow-up question...",
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const resize = useCallback(() => {
      const element = textareaRef.current;
      if (!element) {
        return;
      }
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
    }, []);

    // Layout effect rather than a passive one: the height is measured and applied before
    // paint, so the field never renders at the wrong size for a frame.
    useLayoutEffect(resize, [value, resize]);

    useImperativeHandle(
      ref,
      () => ({
        setDraft(text: string) {
          setValue(text);
          const element = textareaRef.current;
          if (element) {
            element.focus();
            // Place the caret at the end so the seeded text can be edited immediately.
            requestAnimationFrame(() =>
              element.setSelectionRange(text.length, text.length),
            );
          }
        },
        focus() {
          textareaRef.current?.focus();
        },
      }),
      [],
    );

    const canSend = value.trim().length > 0 && !busy && !blockedReason;

    const submit = useCallback(() => {
      const text = value.trim();
      if (!text || busy || blockedReason) {
        return;
      }
      // Cleared only once submission begins. The shell keeps the submitted text, so it can
      // be restored if the request fails.
      setValue("");
      onSubmit(text);
    }, [value, busy, blockedReason, onSubmit]);

    return (
      <div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="srOnly" htmlFor="composer">
            Ask an engineering question
          </label>
          <textarea
            id="composer"
            ref={textareaRef}
            className={styles.textarea}
            rows={1}
            value={value}
            placeholder={blockedReason ? "Backend unavailable" : placeholder}
            disabled={busy || Boolean(blockedReason)}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          {busy ? (
            <Button
              className={styles.stop}
              leadingIcon={<StopIcon size={14} />}
              onClick={onCancel}
            >
              Stop
            </Button>
          ) : (
            <button
              type="submit"
              className={styles.send}
              disabled={!canSend}
              aria-label="Send question"
              title="Send question"
            >
              <SendIcon size={16} />
            </button>
          )}
        </form>

        <div className={[styles.hint, "metaText"].join(" ")}>
          {blockedReason ? (
            <span className={styles.disabledNote}>{blockedReason}</span>
          ) : busy ? (
            <span>Running. Press Stop to cancel this analysis.</span>
          ) : (
            <span>Enter to send &middot; Shift+Enter for a new line</span>
          )}
        </div>
      </div>
    );
  },
);

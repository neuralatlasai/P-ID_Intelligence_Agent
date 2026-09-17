"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/Button";
import { AlertIcon } from "@/components/ui/icons";

/**
 * The route error boundary.
 *
 * It catches a render failure — a malformed projection, an unexpected item shape — so one
 * bad turn cannot take down the application shell. The message names what happened and
 * offers the one action that can help, rather than a generic apology.
 */
export default function SessionError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    // Logged for the operator. The message is not shown to the user verbatim: a render
    // error's text is not a controlled surface and can quote content.
    console.error("[session] render failure:", error.message, error.digest ?? "");
  }, [error]);

  return (
    <div className="appFrame">
      <div
        style={{
          display: "grid",
          gap: "var(--space-4)",
          justifyItems: "start",
          padding: "var(--space-8)",
          maxInlineSize: "60ch",
        }}
      >
        <h1
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            fontSize: "var(--text-xl)",
          }}
        >
          <AlertIcon size={20} />
          This session could not be displayed
        </h1>
        <p style={{ color: "var(--text-secondary)", lineHeight: "var(--leading-relaxed)" }}>
          Something in the conversation failed to render. Your conversation is stored on the
          backend and is not affected; reloading re-reads it from there.
        </p>
        {error.digest ? (
          <p className="metaText mono">Error reference: {error.digest}</p>
        ) : null}
        <Button variant="primary" onClick={reset}>
          Reload this session
        </Button>
      </div>
    </div>
  );
}

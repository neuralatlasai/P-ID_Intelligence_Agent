import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBackendHealth } from "@/hooks/useSession";

/**
 * A not-ready health result locks the composer. These tests pin that one failed probe does
 * not keep it locked for the whole five-minute poll: the hook rechecks with a short backoff
 * and returns to the slow poll once the backend answers ready.
 */

function healthResponse(status: "ready" | "down"): Response {
  return new Response(JSON.stringify({ status, corpusFiles: 1049 }), {
    headers: { "content-type": "application/json" },
  });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useBackendHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rechecks within seconds after a failed probe and recovers without waiting for the poll", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValue(healthResponse("ready"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBackendHealth());
    await flush();
    expect(result.current.status).toBe("down");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await flush(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ready");

    // Ready again: no further fast rechecks, only the slow poll.
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off while the backend stays down and stops when unmounted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(healthResponse("down"));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useBackendHealth());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    unmount();
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

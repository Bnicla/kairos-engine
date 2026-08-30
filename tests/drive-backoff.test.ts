import { describe, expect, it, vi } from "vitest";
import { withBackoff, withDriveBackoff, type DriveOps } from "../apps/cloud/store/drive-ops";

const throttled = (status: number) => ({ response: { status, headers: { "retry-after": "0.001" } } });

describe("withBackoff (REQ-7 — Drive quota resilience)", () => {
  it("retries 429 and succeeds within the attempt budget", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(throttled(429))
      .mockRejectedValueOnce(throttled(503))
      .mockResolvedValueOnce("ok");
    await expect(withBackoff(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the attempt budget and rethrows the throttle error", async () => {
    const fn = vi.fn().mockRejectedValue(throttled(429));
    await expect(withBackoff(fn)).rejects.toMatchObject({ response: { status: 429 } });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors (404 fails fast)", async () => {
    const fn = vi.fn().mockRejectedValue({ response: { status: 404 } });
    await expect(withBackoff(fn)).rejects.toMatchObject({ response: { status: 404 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry plain errors with no status", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withBackoff(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withDriveBackoff", () => {
  it("wraps every op so transient throttles are absorbed", async () => {
    const download = vi.fn().mockRejectedValueOnce(throttled(500)).mockResolvedValueOnce("content");
    const ops = { downloadText: download } as unknown as DriveOps;
    const wrapped = withDriveBackoff(ops);
    await expect(wrapped.downloadText("id1")).resolves.toBe("content");
    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledWith("id1");
  });
});

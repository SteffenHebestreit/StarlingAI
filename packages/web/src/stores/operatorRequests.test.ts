import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOperatorRequestsStore } from "./operatorRequests";

// The store reads two things of the gateway store: whether it is connected, and authorizedFetch,
// which throws with the gateway's error message on a non-2xx answer. A stand-in with just those.
const gateway = vi.hoisted(() => ({ connected: false, authorizedFetch: vi.fn() }));
vi.mock("./gateway", () => ({ useGatewayStore: () => gateway }));

const ROUTED = {
  id: "a-1",
  kind: "routed",
  toolName: "record_export",
  args: { record: "r-7" },
  createdAt: "2026-11-14T10:00:00.000Z",
  requester: "patty",
  requesterRole: "requester",
  approverRoles: ["reviewer"],
  distinctApprover: true,
  expiresAt: "2026-11-14T10:05:00.000Z",
};

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  setActivePinia(createPinia());
  gateway.authorizedFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the operator requests' approvals", () => {
  it("keep what a routed approval says about who asked and who may decide it", async () => {
    gateway.authorizedFetch.mockResolvedValueOnce(answer([ROUTED]));
    const requests = useOperatorRequestsStore();
    await requests.fetchApprovals();
    expect(requests.approvals).toEqual([ROUTED]);
  });

  it("keep a refused answer's card, with the gateway's reason, until the next answer to it", async () => {
    gateway.authorizedFetch.mockResolvedValueOnce(answer([ROUTED]));
    const requests = useOperatorRequestsStore();
    await requests.fetchApprovals();

    gateway.authorizedFetch.mockRejectedValueOnce(new Error("A second person must approve this request"));
    await expect(requests.respond("a-1", true)).resolves.toBeUndefined();
    expect(requests.approvals.map((approval) => approval.id)).toEqual(["a-1"]);
    expect(requests.respondError("a-1")).toBe("A second person must approve this request");
    expect(requests.isResponding("a-1")).toBe(false);

    gateway.authorizedFetch.mockResolvedValueOnce(answer({ ok: true, approved: false }));
    await requests.respond("a-1", false);
    expect(requests.approvals).toEqual([]);
    expect(requests.respondError("a-1")).toBeUndefined();
    expect(gateway.authorizedFetch).toHaveBeenLastCalledWith("/api/approval/a-1", expect.objectContaining({ method: "POST", body: JSON.stringify({ approved: false }) }));
  });
});

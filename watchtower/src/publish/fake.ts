import type { MemoRecord } from "../memo/types.js";
import type { PublishedPage, PublisherPort } from "./types.js";

// ── Fake publisher for tests ───────────────────────────────────────

export interface FakePublisher extends PublisherPort {
  readonly published: ReadonlyArray<{ memo: MemoRecord; destinationRef: string }>;
  failNext: (err?: Error) => void;
  clear: () => void;
}

export function createFakePublisher(
  destination: "notion" | "confluence" = "notion",
): FakePublisher {
  const published: Array<{ memo: MemoRecord; destinationRef: string }> = [];
  let pendingFailure: Error | null = null;
  let pageCounter = 0;
  return {
    destination,
    async publish(memo, destinationRef): Promise<PublishedPage> {
      if (pendingFailure) {
        const err = pendingFailure;
        pendingFailure = null;
        throw err;
      }
      pageCounter++;
      published.push({ memo, destinationRef });
      return {
        pageId: `fake-page-${pageCounter}`,
        pageUrl: `https://fake.example/${destination}/${pageCounter}`,
        destination,
      };
    },
    get published() {
      return published;
    },
    failNext(err = new Error("fake publisher failed")) {
      pendingFailure = err;
    },
    clear() {
      published.length = 0;
      pendingFailure = null;
      pageCounter = 0;
    },
  };
}

import { describe, expect, it } from "vitest";
import { createOpenRequests } from "./openRequests";

describe("ファイルを開く要求番号", () => {
  it("同じペインでは最後の要求だけが最新になる", () => {
    const requests = createOpenRequests();
    const first = requests.start("p0");
    const second = requests.start("p0");

    expect(second()).toBe("latest");
    expect(first()).toBe("superseded");
  });

  it("別のペインの要求には影響しない", () => {
    const requests = createOpenRequests();
    const left = requests.start("p0");
    const right = requests.start("p1");

    expect(left()).toBe("latest");
    expect(right()).toBe("latest");
  });

  it("タブを消去したら、同じペインで次の要求があっても以前の要求は無効", () => {
    const requests = createOpenRequests();
    const first = requests.start("p0");
    requests.clear();
    const second = requests.start("p0");

    expect(first()).toBe("cleared");
    expect(second()).toBe("latest");
  });
});

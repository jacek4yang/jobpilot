/**
 * Operator selection filter tests.
 *
 * Pins the narrowing contract of `filterSummariesBySelection`:
 *   - an empty selection is "no restriction" and returns the input unchanged;
 *   - a populated selection narrows to exactly the selected ids;
 *   - ids in the selection that no summary has are simply dropped;
 *   - non-string ids are compared via String(id), matching how the panel
 *     renders and toggles job ids.
 */
import { describe, expect, it } from "vitest";
import { filterSummariesBySelection, isSelectionCurrent } from "../../../src/application/selection";

interface Summary {
  readonly id: unknown;
  readonly title: string;
}

const summaries: readonly Summary[] = [
  { id: "job-1", title: "Backend" },
  { id: "job-2", title: "Frontend" },
  { id: "job-3", title: "Fullstack" },
];

describe("filterSummariesBySelection", () => {
  it("returns every summary when the selection is empty", () => {
    const result = filterSummariesBySelection(summaries, new Set());
    expect(result).toHaveLength(3);
    expect(result).toEqual(summaries);
  });

  it("narrows to exactly the selected ids", () => {
    const result = filterSummariesBySelection(summaries, new Set(["job-1", "job-3"]));
    expect(result.map((s) => s.id)).toEqual(["job-1", "job-3"]);
  });

  it("drops selected ids that no summary has", () => {
    const result = filterSummariesBySelection(summaries, new Set(["job-1", "missing"]));
    expect(result.map((s) => s.id)).toEqual(["job-1"]);
  });

  it("returns nothing when the selection matches no summary", () => {
    const result = filterSummariesBySelection(summaries, new Set(["nope"]));
    expect(result).toHaveLength(0);
  });

  it("compares non-string ids via String(id)", () => {
    const numeric: readonly Summary[] = [
      { id: 101, title: "A" },
      { id: 202, title: "B" },
    ];
    const result = filterSummariesBySelection(numeric, new Set(["202"]));
    expect(result.map((s) => s.id)).toEqual([202]);
  });

  it("does not mutate the input array", () => {
    const before = [...summaries];
    filterSummariesBySelection(summaries, new Set(["job-2"]));
    expect(summaries).toEqual(before);
  });
});

describe("isSelectionCurrent", () => {
  it("applies only when the selection was made on the current page", () => {
    expect(
      isSelectionCurrent(
        "https://www.zhipin.com/web/geek/jobs?query=java",
        "https://www.zhipin.com/web/geek/jobs?query=java",
      ),
    ).toBe(true);
  });

  it("is stale on any other page, even same-origin", () => {
    expect(
      isSelectionCurrent(
        "https://www.zhipin.com/web/geek/jobs?query=java",
        "https://www.zhipin.com/web/geek/jobs?query=python",
      ),
    ).toBe(false);
    expect(
      isSelectionCurrent(
        "https://www.zhipin.com/web/geek/jobs?query=java",
        "https://www.zhipin.com/web/geek/chat",
      ),
    ).toBe(false);
  });

  it("is stale when no selection href was recorded", () => {
    expect(isSelectionCurrent(undefined, "https://www.zhipin.com/web/geek/jobs")).toBe(false);
  });
});

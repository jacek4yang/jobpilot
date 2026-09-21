import { describe, expect, it } from "vitest";
import { clampGeometry, GEOMETRY_LIMITS, getSizeCategory } from "../../../src/ui/layout/geometry";

describe("geometry and clamping", () => {
  const standardViewport = { innerWidth: 1920, innerHeight: 1080 };
  const smallViewport = { innerWidth: 800, innerHeight: 600 };

  it("applies default width and height when stored values are absent", () => {
    const geo = clampGeometry(undefined, standardViewport);
    expect(geo.width).toBe(GEOMETRY_LIMITS.DEFAULT_WIDTH);
    expect(geo.height).toBe(GEOMETRY_LIMITS.DEFAULT_HEIGHT);
    expect(geo.collapsed).toBe(false);
  });

  it("enforces minimum width and height constraints", () => {
    const geo = clampGeometry({ width: 100, height: 100 }, standardViewport);
    expect(geo.width).toBe(GEOMETRY_LIMITS.MIN_WIDTH);
    expect(geo.height).toBe(GEOMETRY_LIMITS.MIN_HEIGHT);
  });

  it("enforces maximum bounds relative to viewport", () => {
    const geo = clampGeometry({ width: 3000, height: 3000 }, smallViewport);
    // In small viewport (800x600):
    // Max width: min(880, 800 - 32) = 768
    // Max height: min(1200, 600 - 32) = 568
    expect(geo.width).toBeLessThanOrEqual(smallViewport.innerWidth - 32);
    expect(geo.height).toBeLessThanOrEqual(smallViewport.innerHeight - 32);
  });

  it("clamps coordinates back inside visible viewport when window shrinks", () => {
    // Saved coordinates were at x=1500, y=900 (for a 1920x1080 screen)
    // Now screen is resized to 800x600
    const geo = clampGeometry(
      { width: 480, height: 450, position: { x: 1500, y: 900 } },
      smallViewport,
    );

    expect(geo.x + geo.width).toBeLessThanOrEqual(
      smallViewport.innerWidth - GEOMETRY_LIMITS.VIEWPORT_MARGIN,
    );
    expect(geo.y + geo.height).toBeLessThanOrEqual(
      smallViewport.innerHeight - GEOMETRY_LIMITS.VIEWPORT_MARGIN,
    );
    expect(geo.x).toBeGreaterThanOrEqual(GEOMETRY_LIMITS.VIEWPORT_MARGIN);
    expect(geo.y).toBeGreaterThanOrEqual(GEOMETRY_LIMITS.VIEWPORT_MARGIN);
  });

  it("categorizes size buckets correctly for responsive layouts", () => {
    expect(getSizeCategory(360)).toBe("compact");
    expect(getSizeCategory(410)).toBe("compact");
    expect(getSizeCategory(460)).toBe("normal");
    expect(getSizeCategory(520)).toBe("normal");
    expect(getSizeCategory(600)).toBe("large");
    expect(getSizeCategory(750)).toBe("large");
  });
});

import { describe, expect, it } from "vitest";
import { createCompany } from "../../../src/domain/company/company";
import { canonicalizeUrl, fingerprintJob } from "../../../src/domain/job/job";
import { normalizeCity, parseLocation } from "../../../src/domain/job/location";
import { parseSalary } from "../../../src/domain/job/salary";
import { asPlatformId } from "../../../src/domain/support/ids";
import { fnv1a32 } from "../../../src/domain/support/shared";

const boss = asPlatformId("boss");

describe("fnv1a32", () => {
  it("is deterministic", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
  });

  it("differs for different inputs", () => {
    expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
  });

  it("produces 8 lowercase hex characters", () => {
    expect(fnv1a32("anything")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles the empty string", () => {
    expect(fnv1a32("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles non-ASCII input", () => {
    expect(fnv1a32("前端开发工程师")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("job fingerprinting", () => {
  const base = {
    platform: boss,
    companyName: "示例科技",
    title: "前端开发工程师",
    locationRaw: "北京·朝阳区",
    canonicalUrl: "https://www.zhipin.com/job_detail/abc123.html",
  };

  it("is deterministic across calls", () => {
    expect(fingerprintJob(base)).toBe(fingerprintJob(base));
  });

  it("does not use randomness: repeated derivation is stable", () => {
    const ids = new Set(Array.from({ length: 50 }, () => fingerprintJob(base)));
    expect(ids.size).toBe(1);
  });

  it("prefixes the id so fallbacks are distinguishable from platform ids", () => {
    expect(fingerprintJob(base).startsWith("fp_")).toBe(true);
  });

  it("ignores surrounding and internal whitespace differences", () => {
    const spaced = { ...base, title: "  前端开发工程师  ", companyName: "示例科技 " };
    expect(fingerprintJob(spaced)).toBe(fingerprintJob(base));
  });

  it("ignores case differences", () => {
    const upper = { ...base, title: "FRONTEND ENGINEER" };
    const lower = { ...base, title: "frontend engineer" };
    expect(fingerprintJob(upper)).toBe(fingerprintJob(lower));
  });

  it("ignores tracking query parameters in the URL", () => {
    const tracked = {
      ...base,
      canonicalUrl: "https://www.zhipin.com/job_detail/abc123.html?lid=xyz&securityId=123",
    };
    expect(fingerprintJob(tracked)).toBe(fingerprintJob(base));
  });

  it("produces different ids for different companies", () => {
    expect(fingerprintJob({ ...base, companyName: "另一家公司" })).not.toBe(fingerprintJob(base));
  });

  it("produces different ids for different titles", () => {
    expect(fingerprintJob({ ...base, title: "后端开发工程师" })).not.toBe(fingerprintJob(base));
  });

  it("produces different ids for different locations", () => {
    expect(fingerprintJob({ ...base, locationRaw: "上海·浦东新区" })).not.toBe(
      fingerprintJob(base),
    );
  });

  it("produces different ids for different platforms", () => {
    expect(fingerprintJob({ ...base, platform: asPlatformId("liepin") })).not.toBe(
      fingerprintJob(base),
    );
  });

  it("works when no canonical URL is available", () => {
    const withoutUrl = {
      platform: base.platform,
      companyName: base.companyName,
      title: base.title,
      locationRaw: base.locationRaw,
    };
    expect(fingerprintJob(withoutUrl)).toMatch(/^fp_[0-9a-f]{8}$/);
  });

  it("distinguishes a job with a URL from the same job without one", () => {
    const withoutUrl = {
      platform: base.platform,
      companyName: base.companyName,
      title: base.title,
      locationRaw: base.locationRaw,
    };
    expect(fingerprintJob(withoutUrl)).not.toBe(fingerprintJob(base));
  });
});

describe("canonicalizeUrl", () => {
  it("strips the query string", () => {
    expect(canonicalizeUrl("https://x.com/a?b=1")).toBe("https://x.com/a");
  });

  it("strips the fragment", () => {
    expect(canonicalizeUrl("https://x.com/a#frag")).toBe("https://x.com/a");
  });

  it("strips a trailing slash", () => {
    expect(canonicalizeUrl("https://x.com/a/")).toBe("https://x.com/a");
  });

  it("returns undefined for undefined input", () => {
    expect(canonicalizeUrl(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace string", () => {
    expect(canonicalizeUrl("")).toBeUndefined();
    expect(canonicalizeUrl("   ")).toBeUndefined();
  });

  it("handles a malformed URL without throwing", () => {
    expect(() => canonicalizeUrl("not a url?x=1")).not.toThrow();
    expect(canonicalizeUrl("not a url?x=1")).toBe("not a url");
  });
});

describe("salary parsing", () => {
  it("parses a K-denominated range", () => {
    const range = parseSalary("20-35K");
    expect(range.parsed).toBe(true);
    expect(range.min).toBe(20);
    expect(range.max).toBe(35);
  });

  it("parses a range with a months-per-year suffix", () => {
    const range = parseSalary("20-35K·14薪");
    expect(range.min).toBe(20);
    expect(range.max).toBe(35);
    expect(range.monthsPerYear).toBe(14);
  });

  it("orders the range even when written descending", () => {
    const range = parseSalary("35-20K");
    expect(range.min).toBe(20);
    expect(range.max).toBe(35);
  });

  it("parses a single value", () => {
    const range = parseSalary("25K");
    expect(range.min).toBe(25);
    expect(range.max).toBe(25);
  });

  it("scales 万 into K", () => {
    const range = parseSalary("2-3万");
    expect(range.min).toBe(20);
    expect(range.max).toBe(30);
  });

  it("detects a daily rate", () => {
    expect(parseSalary("200-300元/天").period).toBe("day");
  });

  it("marks 面议 as unparsed rather than guessing", () => {
    const range = parseSalary("面议");
    expect(range.parsed).toBe(false);
    expect(range.min).toBeUndefined();
  });

  it("marks an unrecognised string as unparsed", () => {
    expect(parseSalary("competitive").parsed).toBe(false);
  });

  it("handles empty and undefined input", () => {
    expect(parseSalary("").parsed).toBe(false);
    expect(parseSalary(undefined).parsed).toBe(false);
    expect(parseSalary(null).parsed).toBe(false);
  });

  it("always preserves the raw text for explainability", () => {
    expect(parseSalary("20-35K·14薪").raw).toBe("20-35K·14薪");
    expect(parseSalary("面议").raw).toBe("面议");
  });
});

describe("location parsing", () => {
  it("splits city, district and business area", () => {
    const location = parseLocation("北京·朝阳区·望京");
    expect(location.city).toBe("北京");
    expect(location.district).toBe("朝阳区");
    expect(location.businessArea).toBe("望京");
  });

  it("handles a city-only string", () => {
    const location = parseLocation("北京");
    expect(location.city).toBe("北京");
    expect(location.district).toBeUndefined();
  });

  it("handles empty input without inventing a city", () => {
    const location = parseLocation("");
    expect(location.city).toBe("");
    expect(parseLocation(undefined).city).toBe("");
  });

  it("preserves the raw text", () => {
    expect(parseLocation("北京·朝阳区").raw).toBe("北京·朝阳区");
  });

  it("normalizes city suffixes for comparison", () => {
    expect(normalizeCity("北京市")).toBe(normalizeCity("北京"));
    expect(normalizeCity("上海")).toBe(normalizeCity("上海"));
  });
});

describe("company identity", () => {
  it("derives a stable id from the normalized name", () => {
    expect(createCompany({ name: "示例科技" }).id).toBe(createCompany({ name: " 示例科技 " }).id);
  });

  it("keeps the display name trimmed", () => {
    expect(createCompany({ name: "  示例科技  " }).name).toBe("示例科技");
  });

  it("distinguishes different companies", () => {
    expect(createCompany({ name: "A" }).id).not.toBe(createCompany({ name: "B" }).id);
  });
});

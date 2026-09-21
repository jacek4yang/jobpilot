/**
 * BOSS adapter — page classification against the synthetic fixtures.
 *
 * Scope: which `PageKind` the adapter reports for each fixture, the precedence
 * of the CAPTCHA signal over structural evidence, and the fail-closed
 * `"unknown"` outcome for a blank document.
 *
 * These fixtures are synthetic (see `tests/fixtures/boss/*.html`). Passing
 * proves the classifier's ordering is internally consistent; it proves nothing
 * about the live BOSS Zhipin DOM.
 */

import { describe, expect, it } from "vitest";
import { isSupportedHost, isUnverifiedZhipinSubhost } from "../../src/adapters/boss/guards";
import {
  classifyBySwitch,
  detectBossPageKind,
  detectBossPageKindFromSignals,
  type PageKindSignals,
} from "../../src/adapters/boss/parser/page-kind";
import type { PageKind } from "../../src/ports/job-platform";
import {
  asDocument,
  asParseRoot,
  BOSS_URL,
  type BossFixture,
  documentOf,
  loadFixture,
  loadHtml,
  locationOf,
  makeWindow,
  readFixture,
} from "./boss-harness";

/** Classifies fixture markup at the given URL. */
const classify = (html: string, url: string = BOSS_URL): PageKind => {
  const window = loadHtml(html, url);
  return detectBossPageKind(documentOf(window), locationOf(window));
};

/**
 * Classifies at the text-faithful body root.
 *
 * Needed for the fixtures whose only CAPTCHA evidence is visible text: under
 * happy-dom `Document.textContent` is always empty, so the structural document
 * path cannot see text at all. See the harness note.
 *
 * `detectBossPageKind` requires a `Document`; the body root is passed through
 * the same documented happy-dom -> `lib.dom` boundary cast the harness uses,
 * because passing a real `Document` here would defeat the purpose (empty text).
 */
const classifyByText = (html: string, url: string = BOSS_URL): PageKind => {
  const window = loadHtml(html, url);
  return detectBossPageKind(asDocument(asParseRoot(window)), locationOf(window));
};

const CASES: readonly { readonly fixture: BossFixture; readonly kind: PageKind }[] = [
  { fixture: "job-list.html", kind: "job-list" },
  { fixture: "job-detail.html", kind: "job-detail" },
  { fixture: "login.html", kind: "login-required" },
  { fixture: "captcha.html", kind: "captcha" },
  { fixture: "empty-list.html", kind: "empty-result" },
  { fixture: "unsupported.html", kind: "unknown" },
];

describe("boss page classification — fixtures", () => {
  for (const { fixture, kind } of CASES) {
    it(`classifies ${fixture} as ${kind}`, () => {
      const window = loadFixture(fixture);
      const detected = detectBossPageKind(documentOf(window), locationOf(window));
      expect(detected).toBe(kind);
    });
  }

  it("agrees with the text-faithful body root for the text-driven fixtures", () => {
    // A CAPTCHA page whose only evidence is a phrase, with no guard element.
    expect(classifyByText("<html><body><p>请完成安全验证</p></body></html>")).toBe("captcha");
    // The same for a login wall.
    expect(classifyByText("<html><body><p>请先登录后继续</p></body></html>")).toBe(
      "login-required",
    );
  });

  it("classifies an unrelated page as unknown, never as a job list", () => {
    const window = loadFixture("unsupported.html");
    const detected = detectBossPageKind(documentOf(window), locationOf(window));
    expect(detected).toBe("unknown");
    expect(detected).not.toBe("job-list");
  });
});

describe("boss page classification — host safety gate", () => {
  it("rejects a mirror of the job list served from another origin", () => {
    const html = readFixture("job-list.html");
    expect(classify(html, BOSS_URL)).toBe("job-list");
    // Identical markup, untrusted origin: the host gate must fire first.
    expect(classify(html, "https://evil.example.com/web/geek/job")).toBe("unsupported");
  });

  it("accepts only the two exact hostnames, rejecting unverified subdomains", () => {
    expect(isSupportedHost({ href: "https://www.zhipin.com/web/geek/job" })).toBe(true);
    expect(isSupportedHost({ href: "https://zhipin.com/web/geek/job" })).toBe(true);
    expect(isSupportedHost({ href: "https://m.zhipin.com/web/geek/job" })).toBe(false);
    expect(isSupportedHost({ href: "https://evil-zhipin.com/" })).toBe(false);
    expect(isSupportedHost({ href: "not a url" })).toBe(false);

    // The subdomain is recognised as zhipin-shaped but explicitly NOT supported.
    expect(isUnverifiedZhipinSubhost({ href: "https://m.zhipin.com/web/geek/job" })).toBe(true);
    expect(isUnverifiedZhipinSubhost({ href: "https://www.zhipin.com/web/geek/job" })).toBe(false);
  });

  it("rejects the fixtures' list markup even when a card is present", () => {
    const html = readFixture("job-list.html");
    const window = loadHtml(html, "https://m.zhipin.com/web/geek/job");
    expect(detectBossPageKind(documentOf(window), locationOf(window))).toBe("unsupported");
  });
});

describe("boss page classification — precedence", () => {
  /**
   * Synthetic COMBINED page: a CAPTCHA challenge rendered on top of a perfectly
   * well-formed, non-empty job list. This is the state that must never be read
   * as a scannable page.
   */
  const COMBINED = `<!doctype html>
<html lang="zh-CN"><head><title>combined</title></head><body>
  <div class="captcha-container" id="captcha" data-jobpilot-guard="captcha">
    <p>请完成安全验证</p>
  </div>
  <div class="job-list-container">
    <ul class="rec-job-list">
      <div class="job-card-wrap">
        <li class="job-card-box">
          <div class="job-info">
            <div class="job-title clearfix">
              <a href="/job_detail/boss-1001.html?ka=x" class="job-name">前端开发工程师</a>
              <span class="job-salary">20-35K·14薪</span>
            </div>
            <ul class="tag-list"><li>本科</li><li>3-5年</li></ul>
          </div>
          <div class="job-card-footer">
            <a href="/gongsi/acme-1001.html?from=top-card" class="boss-info">
              <div class="boss-logo"><span class="boss-online-icon"></span></div>
              <span class="boss-name">未来科技有限公司</span>
            </a>
            <span class="company-location">北京·朝阳区·望京</span>
          </div>
        </li>
      </div>
    </ul>
  </div>
</body></html>`;

  it("reports captcha for a page that is both a CAPTCHA and a job list", () => {
    const window = loadHtml(COMBINED);
    expect(detectBossPageKind(documentOf(window), locationOf(window))).toBe("captcha");
  });

  it("reports captcha even when the text-faithful root sees both signals", () => {
    const window = loadHtml(COMBINED);
    const root = asParseRoot(window);
    // Both signals really are present on this document — the captcha guard
    // element and a parseable card — so "captcha" is a precedence decision, not
    // an accident of the document being unreadable.
    expect(root.querySelector("[data-jobpilot-guard='captcha']")).not.toBeNull();
    expect(root.querySelectorAll(".job-card-wrap").length).toBeGreaterThan(0);
    expect(detectBossPageKind(asDocument(root), locationOf(window))).toBe("captcha");
  });

  it("ranks captcha above risk control, login, detail and list evidence", () => {
    const base: PageKindSignals = {
      captcha: true,
      riskControl: true,
      loginRequired: true,
      hasJobDetailRoot: true,
      hasJobListRoot: true,
      cardCount: 3,
      emptyResultMarker: true,
      supportedHost: true,
    };
    expect(detectBossPageKindFromSignals(base)).toEqual({
      kind: "captcha",
      reason: "captcha-guard",
    });
    expect(classifyBySwitch(base)).toEqual({ kind: "captcha", reason: "captcha-guard" });
  });

  it("ranks the unsupported host above every structural signal", () => {
    const signals: PageKindSignals = {
      captcha: true,
      riskControl: true,
      loginRequired: true,
      hasJobDetailRoot: true,
      hasJobListRoot: true,
      cardCount: 3,
      emptyResultMarker: true,
      supportedHost: false,
    };
    expect(detectBossPageKindFromSignals(signals)).toEqual({
      kind: "unsupported",
      reason: "unsupported-host",
    });
    expect(classifyBySwitch(signals)).toEqual({ kind: "unsupported", reason: "unsupported-host" });
  });
});

describe("boss page classification — fail closed", () => {
  it("classifies a blank document as unknown", () => {
    const window = makeWindow();
    expect(detectBossPageKind(documentOf(window), locationOf(window))).toBe("unknown");
  });

  it("classifies a whitespace-only document as unknown", () => {
    expect(classify("<!doctype html>\n<html><body>   \n\t  </body></html>")).toBe("unknown");
  });

  it("classifies a document with no evidence as unknown, not as a guess", () => {
    const window = loadFixture("unsupported.html");
    const decision = detectBossPageKindFromSignals({
      captcha: false,
      riskControl: false,
      loginRequired: false,
      hasJobDetailRoot: false,
      hasJobListRoot: false,
      cardCount: 0,
      emptyResultMarker: false,
      supportedHost: true,
    });
    expect(decision).toEqual({ kind: "unknown", reason: "no-evidence" });
    expect(detectBossPageKind(documentOf(window), locationOf(window))).toBe("unknown");
  });

  it("never reports job-list for a document it cannot read", () => {
    for (const html of ["", "<!doctype html><html></html>", "<html><body></body></html>"]) {
      expect(classify(html)).not.toBe("job-list");
    }
  });

  it("treats a risk-control interstitial as unknown rather than actionable", () => {
    expect(classifyByText("<html><body><p>操作过于频繁，请稍后再试</p></body></html>")).toBe(
      "unknown",
    );
  });

  it("classifies an empty-result phrase with no marker element as empty-result", () => {
    expect(classifyByText("<html><body><p>暂无职位</p></body></html>")).toBe("empty-result");
  });
});

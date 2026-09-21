import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { detectBossDetailedPageKind } from "../../../src/adapters/boss/parser/page-kind";

describe("BossDetailedPageKind detection", () => {
  it("detects human verification on captcha markup", () => {
    const window = new Window({ url: "https://www.zhipin.com/web/geek/job" });
    const doc = window.document;
    doc.body.innerHTML = `
      <div data-jobpilot-list></div>
      <div data-jobpilot-guard="captcha">请完成安全验证后继续</div>
    `;

    const res = detectBossDetailedPageKind(
      doc as unknown as Document,
      window.location as unknown as Location,
    );
    expect(res.kind).toBe("human-verification");
  });

  it("detects login-required on login wall", () => {
    const window = new Window({ url: "https://www.zhipin.com/web/geek/job" });
    const doc = window.document;
    doc.body.innerHTML = `
      <div data-jobpilot-guard="login-required">
        <span>登录后查看更多职位</span>
      </div>
    `;

    const res = detectBossDetailedPageKind(
      doc as unknown as Document,
      window.location as unknown as Location,
    );
    expect(res.kind).toBe("login-required");
  });

  it("detects job-detail on posting detail page", () => {
    const window = new Window({ url: "https://www.zhipin.com/job_detail/abc.html" });
    const doc = window.document;
    doc.body.innerHTML = `
      <div data-jobpilot-detail>
        <h1 class="name">测试开发</h1>
      </div>
    `;

    const res = detectBossDetailedPageKind(
      doc as unknown as Document,
      window.location as unknown as Location,
    );
    expect(res.kind).toBe("job-detail");
  });

  it("detects chat context on chat route", () => {
    const window = new Window({ url: "https://www.zhipin.com/web/geek/chat" });
    const doc = window.document;
    doc.body.innerHTML = `<div class="chat-conversation"></div>`;

    const res = detectBossDetailedPageKind(
      doc as unknown as Document,
      window.location as unknown as Location,
    );
    expect(res.kind).toBe("chat");
  });

  it("detects search on query path", () => {
    const window = new Window({
      url: "https://www.zhipin.com/web/geek/job?query=python&city=101110100",
    });
    const doc = window.document;
    doc.body.innerHTML = `
      <div data-jobpilot-list>
        <li data-jobpilot-card>岗位1</li>
        <li data-jobpilot-card>岗位2</li>
      </div>
    `;

    const res = detectBossDetailedPageKind(
      doc as unknown as Document,
      window.location as unknown as Location,
    );
    expect(res.kind).toBe("search");
  });
});

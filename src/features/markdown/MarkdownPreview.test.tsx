import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("MarkdownPreview", () => {
  test("enables only real GFM task checkboxes with source positions", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview
        content={"- [ ] 未完成\n- [x] 完成\n  - [ ] 子任务\n\n```md\n- [ ] code\n```"}
        onContentChange={() => {}}
      />,
    );
    expect((markup.match(/type="checkbox"/g) ?? []).length).toBe(3);
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('aria-label="未完成"');
    expect(markup).toContain('checked=""');
  });
  test("keeps preview read-only when no edit callback is provided", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="- [ ] readonly" />);
    expect(markup).toContain('disabled=""');
  });
  test("marks rendered Markdown content as selectable", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# 花笺\n\n正文" />);

    expect(markup).toContain("markdown-selectable");
    expect(markup).toContain("<h1");
    expect(markup).toContain("花笺");
    expect(markup).toContain("正文");
  });

  test("keeps code block controls outside the horizontally scrollable pre", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content={"```text\nvery long code line\n```"} />,
    );

    const preCloseIndex = markup.indexOf("</pre>");
    const buttonIndex = markup.indexOf("<button");

    expect(markup).toContain("markdown-code-block");
    expect(markup).toContain("markdown-code-scroll");
    expect(preCloseIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeGreaterThan(preCloseIndex);
  });
});

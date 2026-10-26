import { describe, expect, test } from "vitest";
import { taskEnter, taskLines } from "./taskEditing";

const apply = (value: string, edit: ReturnType<typeof taskLines>) =>
  value.slice(0, edit.start) + edit.text + value.slice(edit.end);
describe("todo editor actions", () => {
  test("inserts at the current line and leaves the cursor after the marker", () => {
    const edit = taskLines("", 0);
    expect(apply("", edit)).toBe("- [ ] ");
    expect(edit.selectionStart).toBe(6);
    expect(apply("before\n任务", taskLines("before\n任务", 9))).toBe("before\n- [ ] 任务");
  });
  test("converts selected nonempty lines, preserving indentation and existing tasks", () => {
    const text = "项目\n\n  - 已有列表\n- [x] 完成";
    expect(apply(text, taskLines(text, 0, text.length))).toBe(
      "- [ ] 项目\n\n  - [ ] 已有列表\n- [x] 完成",
    );
    expect(apply("a\nb", taskLines("a\nb", 0, 2))).toBe("- [ ] a\nb");
  });
  test("continues completed tasks as unchecked and preserves the split tail", () => {
    const value = "  - [x] 已完成";
    const edit = taskEnter(value, value.length)!;
    expect(apply(value, edit)).toBe(value + "\n  - [ ] ");
    const middle = taskEnter("- [ ] firstsecond", 11)!;
    expect(apply("- [ ] firstsecond", middle)).toBe("- [ ] first\n- [ ] second");
  });
  test("empty task exits; ordinary text and selections keep native Enter", () => {
    expect(apply("- [ ] ", taskEnter("- [ ] ", 6)!)).toBe("");
    expect(taskEnter("ordinary", 8)).toBeNull();
    expect(taskEnter("- [ ] task", 6, 8)).toBeNull();
    expect(taskEnter("- [ ] task", 2)).toBeNull();
  });
});

/**
 * P0 spike：只验证「位置与层级能不能用」，不接 RPC、不做搜索结果。
 *
 * 1. `window.bottom` 里挂 320×200、position:fixed 的红框浮层，确认固定定位相对视口生效；
 * 2. `session.header` 里挂图标按钮，确认排在 ⋯ 之后、与原生图标同间距；
 * 3. 浮层输入框拦截 ↑ ↓ Esc Enter，确认不冒泡到时间线。
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import type { Context } from "@opencode/plugin/gui";

export const SPIKE_CSS = `
.oc-spike-overlay {
  position: fixed;
  top: 80px;
  right: 40px;
  z-index: 40;
  width: 320px;
  height: 200px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 2px solid rgba(255, 72, 72, .85);
  border-radius: 8px;
  background: rgba(255, 0, 0, .18);
  backdrop-filter: blur(2px);
  color: #fff;
  font-size: 11px;
  line-height: 1.45;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .8);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .35);
}
/* 只影响 .session-header-actions（flex 容器）里的排位，让图标排在原生 Ctrl+F 条之前。 */
.oc-spike-header {
  order: -1;
  display: inline-flex;
  align-items: center;
}
.oc-spike-overlay .oc-spike-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .04em;
  color: #ffd7d7;
}
.oc-spike-overlay input {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, .45);
  border-radius: 6px;
  background: rgba(0, 0, 0, .45);
  color: #fff;
  font: inherit;
  outline: none;
}
.oc-spike-overlay input:focus { border-color: #fff; }
.oc-spike-overlay .oc-spike-probe {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.oc-spike-overlay .oc-spike-keys {
  color: #ffe6a3;
}
.oc-spike-overlay .oc-spike-flow {
  color: #b8ffd0;
}
`;

const TRACKED = new Set(["ArrowUp", "ArrowDown", "Escape", "Enter"]);

/** 找出会限制 position:fixed 的祖先（transform / filter / perspective / contain）。 */
function findContainingAncestors(start: HTMLElement | null): string[] {
  const hits: string[] = [];
  let node: HTMLElement | null = start?.parentElement ?? null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const reasons: string[] = [];
    if (style.transform !== "none") reasons.push(`transform=${style.transform}`);
    if (style.filter !== "none") reasons.push(`filter=${style.filter}`);
    if (style.perspective !== "none") reasons.push(`perspective=${style.perspective}`);
    if (style.contain && style.contain !== "none") reasons.push(`contain=${style.contain}`);
    if (style.willChange && /transform|filter/.test(style.willChange)) {
      reasons.push(`will-change=${style.willChange}`);
    }
    if (reasons.length) {
      const id = node.id ? `#${node.id}` : "";
      const cls = node.className
        ? `.${String(node.className).trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
      hits.push(`${node.tagName.toLowerCase()}${id}${cls} [${reasons.join(", ")}]`);
    }
    node = node.parentElement;
  }
  return hits;
}

export function SpikeOverlay() {
  let panel: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  const [probe, setProbe] = createSignal("测量中…");
  const [keys, setKeys] = createSignal<string[]>([]);
  const [flow, setFlow] = createSignal("等待自测…");
  let captureSeen = 0;
  let bubbleSeen = 0;
  let bubbleAllSeen = 0;
  let selftested = false;

  function measure() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const expectedLeft = viewport.w - 40 - rect.width;
    const expectedTop = 80;
    const dx = Math.round(rect.left - expectedLeft);
    const dy = Math.round(rect.top - expectedTop);

    const ancestors = findContainingAncestors(panel);
    const topmost = document.elementFromPoint(rect.left + 8, rect.top + 8);
    const onTop = Boolean(topmost && panel.contains(topmost));
    const wrapper = panel.parentElement;
    const wrapperRect = wrapper?.getBoundingClientRect();

    setProbe(
      [
        `视口 ${viewport.w}×${viewport.h} · 期望 ${Math.round(expectedLeft)},${expectedTop} · 实测 ${Math.round(rect.left)},${Math.round(rect.top)}`,
        `偏差 ${dx},${dy} → ${dx === 0 && dy === 0 ? "fixed 相对视口生效" : "fixed 被祖先限制"}`,
        `尺寸 ${Math.round(rect.width)}×${Math.round(rect.height)} · 最上层命中自己：${onTop ? "是" : "否（被覆盖）"}`,
        `祖先 transform/filter：${ancestors.length ? ancestors.join(" / ") : "无"}${
          wrapperRect
            ? ` · slot 容器 ${Math.round(wrapperRect.width)}×${Math.round(wrapperRect.height)}`
            : ""
        }`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // 窗口级探针：捕获阶段发生在输入框之前，冒泡阶段在输入框之后。
  // 我们的 onKeyDown 一旦 stopPropagation，冒泡阶段的探针就不该收到被拦截的键。
  function onCapture(event: KeyboardEvent) {
    if (event.target !== input || !TRACKED.has(event.key)) return;
    captureSeen += 1;
  }

  function onBubble(event: KeyboardEvent) {
    if (event.target !== input) return;
    bubbleAllSeen += 1;
    if (!TRACKED.has(event.key)) return;
    bubbleSeen += 1;
    setFlow(`冒泡漏出：${event.key}（window 收到了，说明没拦住）`);
  }

  onMount(() => {
    measure();
    // 测量放在下一帧，等 slot 布局稳定。
    const raf = requestAnimationFrame(measure);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
    });
  });

  // 自测：合成一次 ArrowDown（被拦截）与一次 a（放行），对比窗口冒泡探针。
  onMount(() => {
    const timer = setTimeout(() => {
      if (selftested || !input) return;
      selftested = true;
      const dispatch = (key: string) => {
        input?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      };
      dispatch("ArrowDown");
      dispatch("a");
      queueMicrotask(() => {
        const blocked = captureSeen === 1 && bubbleSeen === 0 && bubbleAllSeen === 1;
        setFlow(
          `自测 捕获=${captureSeen} 拦截键冒泡=${bubbleSeen} 普通键冒泡=${bubbleAllSeen} → ${
            blocked ? "ArrowDown 被拦截，a 正常冒泡" : "拦截未生效，请检查"
          }`,
        );
        console.log(
          `[spike-p0] self-test capture=${captureSeen} bubbleTracked=${bubbleSeen} bubbleAll=${bubbleAllSeen}`,
        );
      });
    }, 800);
    onCleanup(() => clearTimeout(timer));
  });

  function onKeyDown(event: KeyboardEvent) {
    if (!TRACKED.has(event.key)) return;
    event.stopPropagation();
    const line = `${new Date().toLocaleTimeString()} ${event.key} stopPropagation`;
    // Solid 把 keydown 委托到 document：currentTarget=document 说明交集发生在冒泡末段。
    const where = event.currentTarget === document ? "document(委托)" : "input(原生)";
    console.log(`[spike-p0] ${line} phase=${event.eventPhase} at=${where}`);
    setKeys((previous) => [...previous.slice(-4), `${event.key}✓`]);
  }

  return (
    <div
      ref={panel}
      class="oc-spike-overlay"
      data-oc-spike="overlay"
      data-testid="oc-spike-fixed-overlay"
    >
      <div class="oc-spike-title">P0 · window.bottom fixed 320×200</div>
      <input
        ref={input}
        data-oc-spike="input"
        placeholder="点这里，按 ↑ ↓ Esc Enter"
        onKeyDown={onKeyDown}
      />
      <div class="oc-spike-keys">
        已拦截：{keys().length ? keys().join(" ") : "（无）"}
      </div>
      <div class="oc-spike-flow" data-oc-spike="flow">
        {flow()}
      </div>
      <div class="oc-spike-probe">{probe()}</div>
    </div>
  );
}

export function SpikeHeaderButton(props: { ctx: Context }) {
  return (
    <span class="oc-spike-header" data-oc-spike="header">
      <props.ctx.ui.Tooltip value="搜索全部会话（P0 占位）">
        <props.ctx.ui.IconButton
          icon="magnifying-glass"
          label="搜索全部会话"
          onClick={() => {
            console.log("[spike-p0] header icon clicked");
            const target = document.querySelector<HTMLInputElement>(
              '[data-oc-spike="input"]',
            );
            target?.focus();
          }}
        />
      </props.ctx.ui.Tooltip>
    </span>
  );
}
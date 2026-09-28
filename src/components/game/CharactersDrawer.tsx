import { AnimatePresence, motion } from "framer-motion";
import { useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useGameStore } from "../../store/game";
import type { StateCharacter, StateView } from "../../lib/acp";

/** 是否值得给「秘密」留折叠位：空串与模板占位「无」都算没有秘密 */
function hasSecret(secret: string): boolean {
  const t = secret.trim();
  return t !== "" && t !== "无";
}

/** 面板是否完全没数据（state.md 还没写 / 解析全空）——此时只显示占位说明。
 *  刻意**不**把 `director`（幕后手记）算进「有数据」：v1.14 起面板不再渲染它（剧透收口），
 *  只有手记的 state.md 在玩家侧就等于空面板。 */
function viewIsEmpty(v: StateView | null): boolean {
  if (!v) return true;
  return (
    v.characters.length === 0 &&
    Object.keys(v.protagonist).length === 0 &&
    v.flags.length === 0 &&
    v.foreshadowing.length === 0 &&
    v.status.time === null &&
    v.status.scene === null &&
    v.status.playthrough === null
  );
}

/** 小节标题：与画廊/剧情图详情同款的字距小标 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-5 mb-2 text-meta tracking-[.25em] text-ink-hint first:mt-0">{children}</h3>;
}

/** 键值两列：键淡、值亮（主角卡与剧情状态共用；引擎可自由加字段，按出现顺序铺） */
function KeyValueRows({ entries }: { entries: [string, string][] }) {
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-ui leading-relaxed">
          <dt className="w-[7.5em] flex-none text-ink-hint">{k}</dt>
          <dd className="min-w-0 flex-1 whitespace-pre-wrap text-ink-body">{v || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 好感度：数字醒目 + 底部细进度条 + 0/50/100 刻度；低（≤25）/高（≥75）换色并盖临界小标，
 * 让「快到底了/已经很亲」一眼可读。解析不出（null）显示「—」不画条（数字与「—」的字面是测试契约，别改）。
 */
function FavorMeter({ name, favor }: { name: string; favor: number | null }) {
  const high = favor !== null && favor >= 75;
  const low = favor !== null && favor <= 25;
  const tone = high ? "text-gold" : low ? "text-[#d98b8b]" : "text-[color:var(--accent)]";
  const bar = high ? "bg-gold" : low ? "bg-[#d98b8b]" : "bg-[color:var(--accent)]";
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-meta tracking-[.15em] text-ink-hint">好感度</span>
      <span className={`text-body font-medium tabular-nums ${tone}`}>{favor === null ? "—" : favor}</span>
      <div
        className="relative h-[3px] min-w-0 flex-1 rounded-full bg-white/10"
        data-testid={`character-favor-track-${name}`}
      >
        {favor !== null && <div className={`h-full rounded-full ${bar}`} style={{ width: `${favor}%` }} />}
        {/* 0 / 50 / 100 刻度：两端实一点、中线淡一点（纯装饰，不参与可访问树） */}
        <span aria-hidden className="absolute inset-y-0 left-0 w-px bg-white/30" />
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/20" />
        <span aria-hidden className="absolute inset-y-0 right-0 w-px bg-white/30" />
      </div>
      {low && <span className="flex-none text-micro tracking-[.1em] text-[#d98b8b]">低</span>}
      {high && <span className="flex-none text-micro tracking-[.1em] text-gold">高</span>}
    </div>
  );
}

/** 单张角色卡：名字 + 表情徽章 + 好感度 + 身份/性格/口癖/最近互动；秘密默认折叠（剧透，点击展开） */
function CharacterCard({ c }: { c: StateCharacter }) {
  const [secretOpen, setSecretOpen] = useState(false);
  const rows: [string, string][] = (
    [
      ["身份", c.role],
      ["性格", c.traits],
      ["口癖", c.catchphrase],
      ["最近互动", c.recentInteraction],
    ] as [string, string][]
  ).filter(([, v]) => v.trim() !== "");
  return (
    <article
      data-testid={`character-card-${c.name}`}
      className="rounded-lg border border-white/10 bg-white/[.03] px-3.5 py-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-ui tracking-[.1em] text-ink">{c.name}</h4>
        {c.expression && (
          <span
            data-testid={`character-expression-${c.name}`}
            className="rounded-sm border border-white/15 px-1.5 py-0.5 text-micro tracking-[.12em] text-ink-body"
          >
            {c.expression}
          </span>
        )}
      </div>
      <FavorMeter name={c.name} favor={c.favor} />
      {rows.length > 0 && (
        <div className="mt-2.5">
          <KeyValueRows entries={rows} />
        </div>
      )}
      {hasSecret(c.secret) && (
        <div className="mt-2.5 border-t border-dashed border-white/10 pt-2">
          <button
            type="button"
            data-testid={`character-secret-${c.name}`}
            aria-expanded={secretOpen}
            onClick={() => setSecretOpen(!secretOpen)}
            className="flex items-center gap-1 text-meta tracking-[.15em] text-ink-hint transition-colors hover:text-ink-body"
          >
            <ChevronDown size={12} className={`transition-transform duration-200 ${secretOpen ? "rotate-180" : ""}`} />
            秘密（剧透）
          </button>
          {secretOpen && (
            <p
              data-testid={`character-secret-text-${c.name}`}
              className="mt-1.5 text-meta leading-relaxed text-ink-body"
            >
              {c.secret}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 未了伏笔（剧透保护，v1.14）：默认折叠，照「秘密（剧透）」的既有折叠范式。
 * 伏笔本就是「还没回收的悬念」，摊开等于提前把后面的走向告诉玩家——默认收起、标注「含剧透」，
 * 想看的人自己点开。
 */
function ForeshadowSection({ items }: { items: StateView["foreshadowing"] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="characters-foreshadow"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="mt-5 mb-2 flex items-center gap-1 text-meta tracking-[.15em] text-ink-hint transition-colors hover:text-ink-body"
      >
        <ChevronDown size={12} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        未了伏笔 · {items.length}（含剧透）
      </button>
      {open && (
        <ul data-testid="characters-foreshadow-list" className="space-y-1 text-meta leading-relaxed text-ink-body">
          {items.map((f, i) => (
            <li key={`${i}-${f.text}`} className="flex gap-2">
              <span className="min-w-0 flex-1">{f.text}</span>
              {f.turn !== null && <span className="flex-none text-meta text-ink-hint">第 {f.turn} 幕</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 角色面板抽屉（v1.7）：右滑入，展示引擎维护的世界状态（`GET /api/state` 读 state.md）。
 * 分块：剧情状态（时间/场景/周目）、主角、角色卡（好感度/表情徽章/秘密折叠/最近互动）、线索/伏笔。
 * v1.14 剧透收口：**不再渲染「幕后手记」小节**（导演层字段是幕后情报，不摊给玩家；state.md 仍照旧解析，
 * 只是这里不画）；「未了伏笔」默认折叠 + 标注「含剧透」；「秘密」保持默认折叠。
 * 刷新时机在 store（打开拉一次 + turn_end 面板开着重拉）；换世界清空——这里只渲染 {@link stateView}。
 * stateView 为 null 或解析全空时显示占位说明（还没写过 state.md）。
 * 抽屉语义（v1.9）：role=dialog + aria-modal + 标题作名字，焦点进抽屉、Tab 在抽屉里循环、关时归还；
 * Esc 仍归 App 的关闭链（这里刻意不碰键盘的 Esc）。
 */
export default function CharactersDrawer() {
  const open = useGameStore((s) => s.charactersOpen);
  const view = useGameStore((s) => s.stateView);
  const toggle = useGameStore((s) => s.toggleCharacters);
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, panelRef);

  const statusRows: [string, string][] = [];
  if (view) {
    if (view.status.time !== null) statusRows.push(["时间", view.status.time]);
    if (view.status.scene !== null) statusRows.push(["场景", view.status.scene]);
    if (view.status.playthrough !== null) statusRows.push(["周目", String(view.status.playthrough)]);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          ref={panelRef}
          initial={{ x: "105%" }}
          animate={{ x: 0 }}
          exit={{ x: "105%" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          role="dialog"
          aria-modal="true"
          aria-label="角色面板"
          data-testid="characters-panel"
          className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,92vw)] flex-col border-l border-white/10 bg-panel-strong"
        >
          <header className="flex items-center border-b border-white/10 px-4 py-3.5 text-meta tracking-[.2em] text-ink-hint">
            角 色 面 板
            <button
              type="button"
              onClick={toggle}
              aria-label="关闭角色面板"
              className="ml-auto rounded-md p-1 text-ink-hint transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3.5">
            {viewIsEmpty(view) ? (
              <p data-testid="characters-empty" className="py-5 text-center text-meta leading-relaxed text-ink-hint">
                还没有可展示的角色状态
                <br />
                故事推进后，这里会记下好感度、秘密与线索
              </p>
            ) : (
              <>
                {statusRows.length > 0 && (
                  <section data-testid="characters-status">
                    <SectionTitle>剧情状态</SectionTitle>
                    <KeyValueRows entries={statusRows} />
                  </section>
                )}

                {view && Object.keys(view.protagonist).length > 0 && (
                  <section data-testid="characters-protagonist">
                    <SectionTitle>主角</SectionTitle>
                    <KeyValueRows entries={Object.entries(view.protagonist)} />
                  </section>
                )}

                {view && view.characters.length > 0 && (
                  <section data-testid="characters-list">
                    <SectionTitle>角色卡</SectionTitle>
                    <div className="space-y-2.5">
                      {view.characters.map((c) => (
                        <CharacterCard key={c.name} c={c} />
                      ))}
                    </div>
                  </section>
                )}

                {view && (view.flags.length > 0 || view.foreshadowing.length > 0) && (
                  <section data-testid="characters-notes">
                    {view.flags.length > 0 && (
                      <>
                        <SectionTitle>线索 · {view.flags.length}</SectionTitle>
                        <ul className="space-y-1 text-meta leading-relaxed text-ink-body">
                          {view.flags.map((f) => (
                            <li key={f.name} className="flex gap-2">
                              <span className="text-ink-hint">{f.name}</span>
                              <span className="min-w-0 flex-1">{f.value || "—"}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {view.foreshadowing.length > 0 && <ForeshadowSection items={view.foreshadowing} />}
                  </section>
                )}
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

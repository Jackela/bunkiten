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

/** 面板是否完全没数据（state.md 还没写 / 解析全空）——此时只显示占位说明 */
function viewIsEmpty(v: StateView | null): boolean {
  if (!v) return true;
  return (
    v.characters.length === 0 &&
    Object.keys(v.protagonist).length === 0 &&
    Object.keys(v.director).length === 0 &&
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

/** 键值两列：键淡、值亮（主角卡与幕后手记共用；引擎可自由加字段，按出现顺序铺） */
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

/** 好感度：数字醒目（accent）+ 底部细进度条；解析不出（null）显示「—」不画条 */
function FavorMeter({ favor }: { favor: number | null }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-meta tracking-[.15em] text-ink-hint">好感度</span>
      <span className="text-body font-medium tabular-nums text-[color:var(--accent)]">{favor === null ? "—" : favor}</span>
      <div className="h-[3px] min-w-0 flex-1 rounded-full bg-white/10">
        {favor !== null && <div className="h-full rounded-full bg-[color:var(--accent)]" style={{ width: `${favor}%` }} />}
      </div>
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
          <span data-testid={`character-expression-${c.name}`} className="rounded-sm border border-white/15 px-1.5 py-0.5 text-micro tracking-[.12em] text-ink-body">
            {c.expression}
          </span>
        )}
      </div>
      <FavorMeter favor={c.favor} />
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
            <p data-testid={`character-secret-text-${c.name}`} className="mt-1.5 text-meta leading-relaxed text-ink-body">
              {c.secret}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 角色面板抽屉（v1.7）：右滑入，展示引擎维护的世界状态（`GET /api/state` 读 state.md）。
 * 分块：剧情状态（时间/场景/周目）、主角、角色卡（好感度/表情徽章/秘密折叠/最近互动）、幕后手记、线索/伏笔。
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
                故事推进后，这里会记下好感度、秘密与幕后手记
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

                {view && Object.keys(view.director).length > 0 && (
                  <section data-testid="characters-director">
                    <SectionTitle>幕后手记</SectionTitle>
                    <KeyValueRows entries={Object.entries(view.director)} />
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
                    {view.foreshadowing.length > 0 && (
                      <>
                        <SectionTitle>未了伏笔 · {view.foreshadowing.length}</SectionTitle>
                        <ul className="space-y-1 text-meta leading-relaxed text-ink-body">
                          {view.foreshadowing.map((f, i) => (
                            <li key={`${i}-${f.text}`} className="flex gap-2">
                              <span className="min-w-0 flex-1">{f.text}</span>
                              {f.turn !== null && <span className="flex-none text-meta text-ink-hint">第 {f.turn} 幕</span>}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
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

import { useEffect, useRef, useState } from "react";
import { PenLine, Send } from "lucide-react";
import { useGameStore } from "../../store/game";

/** webkitSpeechRecognition 最小接口（DOM lib 不保证声明） */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: { length: number; [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** 自由输入：文本框 + 语音（Chrome，zh-CN，说完自动发送，行为对齐旧版 #inputrow） */
export default function FreeInput() {
  // 玩家叙事入口：走 sendPlayerTurn 记录在途输入（重掷「重发同一输入」的数据源），不裸调 send
  const sendPlayerTurn = useGameStore((s) => s.sendPlayerTurn);
  const status = useGameStore((s) => s.status);
  const [value, setValue] = useState("");
  const [listening, setListening] = useState(false);
  const [srAvailable] = useState(() => typeof window !== "undefined" && !!getSpeechRecognition());
  const inputRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // 语音 onresult → onend 之间 React 状态未必已刷新，最新转写存 ref
  const transcriptRef = useRef("");

  // 回合就绪后聚焦输入框（对齐旧版 turn_end 行为）
  useEffect(() => {
    if (status === "就绪") inputRef.current?.focus();
  }, [status]);

  useEffect(() => () => recRef.current?.stop(), []);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    setValue("");
    sendPlayerTurn(v);
  };

  const toggleMic = () => {
    const SR = getSpeechRecognition();
    if (!SR) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      transcriptRef.current = Array.from(e.results, (r) => r[0].transcript).join("");
      setValue(transcriptRef.current);
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      const t = transcriptRef.current;
      transcriptRef.current = "";
      if (t.trim()) {
        setValue("");
        sendPlayerTurn(t);
      }
    };
    rec.onerror = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <div className="mt-2.5 flex gap-2">
      {/* 输入行：左侧笔形图标 + 稍强的静息描边 + 主题色聚焦态，和 HUD 其余控件同一套面板语言。
          图标只是装饰（aria-hidden），悬停/聚焦不给它行为；外层 group 只用来把聚焦态递给图标。
          外层 flex-1 顶替原来输入框自己的 flex-1（输入框改 w-full），焦点/回车/语音/IME 流程逐字未动。 */}
      <div className="group relative flex-1">
        <PenLine
          aria-hidden
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-hint transition-colors group-focus-within:text-gold/80"
        />
        <input
          ref={inputRef}
          data-testid="free-input-field"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法选词的 Enter 不算发送
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
          placeholder={listening ? "聆听中…说完自动发送" : "想说什么就写在这里（也可输入数字）"}
          autoComplete="off"
          className="w-full rounded-lg border border-white/15 bg-[rgba(12,14,20,.8)] py-2.5 pl-9 pr-3.5 text-body tracking-[.02em] shadow-[inset_0_1px_0_rgba(255,255,255,.04)] transition-colors placeholder:text-ink-hint focus:border-gold/45 focus:bg-[rgba(16,19,28,.9)]"
        />
      </div>
      {srAvailable && (
        <button
          type="button"
          data-testid="free-input-mic"
          onClick={toggleMic}
          title="语音输入"
          className={`rounded-lg border px-4 text-body transition-colors ${
            listening
              ? "animate-pulse border-[rgba(200,80,80,.6)] bg-[rgba(200,80,80,.35)] text-ink"
              : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
          }`}
        >
          🎙
        </button>
      )}
      {/* 发送：图标版，与麦克风同重量（同一圈描边 + 同色系填充），可读名走 aria-label/title 而不是「→」字形 */}
      <button
        type="button"
        data-testid="free-input-send"
        onClick={submit}
        aria-label="发送"
        title="发送"
        className="flex items-center rounded-lg border border-gold/35 bg-gold/15 px-3.5 text-gold transition-colors hover:border-gold/60 hover:bg-gold/30"
      >
        <Send aria-hidden size={16} />
      </button>
    </div>
  );
}

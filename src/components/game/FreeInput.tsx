import { useEffect, useRef, useState } from "react";
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
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // 中文输入法选词的 Enter 不算发送
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
        }}
        placeholder={listening ? "聆听中…说完自动发送" : "想说什么就写在这里（也可输入数字）"}
        autoComplete="off"
        className="flex-1 rounded-lg border border-white/10 bg-[rgba(12,14,20,.8)] px-3.5 py-2.5 text-[15px] tracking-[.02em] transition-colors focus:border-gold/35"
      />
      {srAvailable && (
        <button
          type="button"
          onClick={toggleMic}
          title="语音输入"
          className={`rounded-lg border px-4 text-[15px] transition-colors ${
            listening
              ? "animate-pulse border-[rgba(200,80,80,.6)] bg-[rgba(200,80,80,.35)] text-ink"
              : "border-gold/35 bg-gold/15 text-gold hover:bg-gold/30"
          }`}
        >
          🎙
        </button>
      )}
      <button
        type="button"
        onClick={submit}
        className="rounded-lg border border-gold/35 bg-gold/15 px-4 text-[15px] text-gold transition-colors hover:bg-gold/30"
      >
        →
      </button>
    </div>
  );
}

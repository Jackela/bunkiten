/** 背景之上的暗角纱，保证对话区可读（对齐旧版 #veil） */
export function Veil() {
  return (
    <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(180deg,rgba(7,8,12,.42),rgba(7,8,12,.18)_30%,rgba(7,8,12,.55)_62%,rgba(7,8,12,.93))]" />
  );
}

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useGameStore } from "../../store/game";

/** 背景层：新图先离屏预载，载完再双层交叉淡入（1.6s，对齐旧版 setBg） */
export default function BgLayer() {
  const bgUrl = useGameStore((s) => s.bgUrl);
  const [shownUrl, setShownUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bgUrl || bgUrl === shownUrl) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive) setShownUrl(bgUrl);
    };
    img.src = bgUrl;
    return () => {
      alive = false;
    };
  }, [bgUrl, shownUrl]);

  return (
    <div className="pointer-events-none fixed inset-0">
      <AnimatePresence>
        {shownUrl && (
          <motion.div
            key={shownUrl}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.6, ease: "easeInOut" }}
            className="absolute inset-0 scale-[1.06] bg-cover bg-center"
            style={{ backgroundImage: `url("${shownUrl}")` }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

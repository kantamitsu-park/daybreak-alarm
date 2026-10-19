import { useEffect, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = setTimeout(
      () => ref.current?.querySelector<HTMLElement>("button,input")?.focus(),
      30,
    );
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = before;
      prior?.focus();
    };
  }, []);
  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        ref={ref}
        className="modal glass"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ y: 60, scale: 0.97 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const els = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input,select,a[href],[tabindex="0"]',
            );
            if (!els?.length) return;
            const first = els[0],
              last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="閉じる">
            <X size={20} />
          </button>
        </header>
        {children}
      </motion.div>
    </motion.div>
  );
}

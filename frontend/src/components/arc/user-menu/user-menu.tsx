"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, Ref } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { PanInfo, Transition, Variants } from "motion/react";
import { ChevronDown, LoaderCircle, LogOut } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./user-menu.module.css";

/**
 * Arc's user menu, trimmed for the workspace sidebar: the account header, one
 * sign-out row, and the phone bottom sheet. Theme, presence and account
 * destination rows are intentionally absent — the app has a dedicated theme
 * switch and the product only needs logout here.
 */
interface UserMenuUser {
  /** The account ID; also the avatar's initial and the menu's accessible name. */
  name: string;
  /** A quiet second line in the menu header, such as the account role. */
  caption?: string;
}

export interface UserMenuProps {
  user: UserMenuUser;
  onSignOut?: () => void | Promise<unknown>;
  align?: "start" | "center" | "end";
  /** Shows the name and a chevron beside the avatar from 640px up. */
  showName?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger button, for returning focus after the menu is swapped out. */
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

type Highlight = { top: number; height: number; glide: boolean };
type OpenReason = "first" | "last" | "pointer" | null;

const compactQuery = "(max-width: 639px)";
const subscribeNothing = () => () => {};
const subscribeCompact = (change: () => void) => {
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
const enter = [...motionTokens.ease.enter] as [number, number, number, number];
const standard = [...motionTokens.ease.standard] as [number, number, number, number];
const exitEase = [0.4, 0, 1, 1] as [number, number, number, number];

/** The panel grows out of the trigger on a critically damped spring; closing is a short fade. */
const panelMotion: Variants = {
  closed: { opacity: 0, scale: 0.94 },
  open: {
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring",
      visualDuration: 0.3,
      bounce: 0,
      opacity: { duration: motionTokens.duration.fast, ease: enter },
      delayChildren: 0.03,
      staggerChildren: 0.016,
    },
  },
  exit: { opacity: 0, scale: 0.97, transition: { duration: motionTokens.duration.instant, ease: exitEase } },
};
const sheetMotion: Variants = {
  closed: { y: "100%" },
  open: { y: 0, transition: { ...motionTokens.spring.smooth, visualDuration: 0.36, delayChildren: 0.06, staggerChildren: 0.02 } },
  exit: { y: "100%", transition: { duration: 0.22, ease: exitEase } },
};
const stillMotion: Variants = {
  closed: { opacity: 0 },
  open: { opacity: 1, transition: { duration: motionTokens.duration.instant } },
  exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } },
};
const rowMotion: Variants = {
  closed: { opacity: 0, y: 3 },
  open: { opacity: 1, y: 0, transition: { duration: 0.2, ease: enter } },
};

function avatarHue(name: string): number {
  let hash = 7;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  return hash;
}

function initial(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

/** A solid colour plus the ID's first character — no photos, no gradients. */
function Portrait({ name, size }: { name: string; size: "sm" | "md" }) {
  return (
    <span className={styles.face} data-size={size}>
      <span
        className={styles.portrait}
        style={{ "--avatar-hue": avatarHue(name) } as CSSProperties}
        aria-hidden="true"
      >
        {initial(name)}
      </span>
    </span>
  );
}

function getStops(root: HTMLElement | null) {
  return Array.from(root?.querySelectorAll<HTMLElement>("[data-stop]") ?? []);
}

export function UserMenu({
  user,
  onSignOut,
  align = "end",
  showName = false,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ref,
  className,
}: UserMenuProps) {
  const id = useId();
  const menuId = `${id}-menu`;
  const triggerId = `${id}-trigger`;
  const reduced = !!useReducedMotion();
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const compact = useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(compactQuery).matches,
    () => false,
  );
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const [signingOut, setSigningOut] = useState(false);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const open = openProp ?? innerOpen;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reason = useRef<OpenReason>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const sheet = hydrated && compact;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function setTriggerRef(node: HTMLButtonElement | null) {
    triggerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
  }

  function setOpen(next: boolean, why: OpenReason = null) {
    reason.current = next ? why : null;
    if (next) setSigningOut(pending.current);
    setHighlight(null);
    setInnerOpen(next);
    onOpenChange?.(next);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  // Focus moves in only when a person opened the menu, so a menu that starts
  // open never steals focus or scrolls the page.
  useEffect(() => {
    if (!open) return;
    const why = reason.current;
    reason.current = null;
    if (!why) return;
    const frame = requestAnimationFrame(() => {
      const stops = getStops(listRef.current);
      const target = why === "last" ? stops.at(-1) : stops[0];
      if (target) target.focus({ preventScroll: true });
      else surfaceRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, sheet]);

  // The panel is placed against the trigger and scales from the avatar's
  // centre, flipping above when there is no room below.
  useLayoutEffect(() => {
    if (!open || sheet) return;
    const place = () => {
      const panel = surfaceRef.current;
      const trigger = triggerRef.current;
      if (!panel || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const wanted =
        align === "start" ? rect.left : align === "center" ? rect.left + rect.width / 2 - width / 2 : rect.right - width;
      const left = Math.min(Math.max(12, wanted), window.innerWidth - width - 12);
      const below = rect.bottom + 8;
      const top =
        below + height > window.innerHeight - 12 && rect.top - 8 - height > 12
          ? rect.top - 8 - height
          : below;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      const faceCenter = rect.left + Math.min(rect.width, 40) / 2;
      const originX = align === "end" && rect.width > 40 ? rect.right - 20 - left : faceCenter - left;
      panel.style.setProperty("--origin-x", `${Math.min(Math.max(0, originX), width)}px`);
      panel.style.setProperty("--origin-y", top < rect.top ? `${height}px` : "0px");
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, sheet, align]);

  // Outside presses close the panel. The sheet has its own scrim.
  useEffect(() => {
    if (!open || sheet) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      reason.current = null;
      setHighlight(null);
      setInnerOpen(false);
      onOpenChange?.(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, sheet, onOpenChange]);

  // The page behind the sheet stays put.
  useEffect(() => {
    if (!open || !sheet) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open, sheet]);

  function signOut() {
    if (pending.current) return;
    const result = onSignOut?.();
    if (!result || typeof result.then !== "function") {
      close(true);
      return;
    }
    // Async sign out keeps the menu open with its progress on the item, then
    // closes once it settles.
    pending.current = true;
    setSigningOut(true);
    const done = () => {
      pending.current = false;
      if (mounted.current) close(false);
    };
    result.then(done, done);
  }

  function onListFocus(event: FocusEvent<HTMLDivElement>) {
    const stop =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-stop]")
        : null;
    if (!stop) {
      setHighlight(null);
      return;
    }
    setHighlight((current) => ({
      top: stop.offsetTop,
      height: stop.offsetHeight,
      glide: current !== null,
    }));
  }

  function onItemPointerMove(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    if (document.activeElement !== event.currentTarget) {
      event.currentTarget.focus({ preventScroll: true });
    }
  }

  function onListPointerLeave(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    setHighlight(null);
    surfaceRef.current?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const stops = getStops(listRef.current);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = active?.closest<HTMLElement>("[data-stop]") ?? null;
    const index = current ? stops.indexOf(current) : -1;
    const step = (to: HTMLElement | undefined) => {
      event.preventDefault();
      to?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        return step(stops[(index + 1) % stops.length]);
      case "ArrowUp":
        return step(stops[index <= 0 ? stops.length - 1 : index - 1]);
      case "Home":
        return step(stops[0]);
      case "End":
        return step(stops.at(-1));
      case "Escape":
      case "Tab":
        event.preventDefault();
        return close(true);
    }
  }

  function onTriggerClick(event: MouseEvent<HTMLButtonElement>) {
    if (open) {
      close(false);
      return;
    }
    setOpen(true, event.detail === 0 ? "first" : "pointer");
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true, event.key === "ArrowDown" ? "first" : "last");
  }

  function onDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.y > 80 || info.velocity.y > 500) close(true);
  }

  const glide: Transition =
    highlight?.glide && !reduced ? motionTokens.spring.snappy : { duration: 0 };
  const row = reduced ? undefined : rowMotion;
  const menuProps = {
    id: menuId,
    role: "menu" as const,
    "aria-labelledby": triggerId,
    tabIndex: -1,
    onKeyDown,
  };

  const content = (
    <>
      <motion.div className={styles.header} variants={row}>
        <Portrait name={user.name} size="md" />
        <div className={styles.identity}>
          <span className={styles.name}>{user.name}</span>
          {user.caption ? <span className={styles.caption}>{user.caption}</span> : null}
        </div>
      </motion.div>
      <div
        ref={listRef}
        className={styles.list}
        onFocus={onListFocus}
        onPointerLeave={onListPointerLeave}
      >
        <motion.span
          className={styles.highlight}
          aria-hidden="true"
          initial={false}
          animate={highlight ? { y: highlight.top, height: highlight.height, opacity: 1 } : { opacity: 0 }}
          transition={{
            default: glide,
            opacity: { duration: reduced ? 0 : motionTokens.duration.instant },
          }}
        />
        <div className={styles.separator} role="separator" />
        <motion.button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={styles.item}
          data-stop="item"
          data-label="退出登录"
          variants={row}
          aria-busy={signingOut || undefined}
          onPointerMove={onItemPointerMove}
          onClick={signOut}
        >
          <span className={styles.icon} aria-hidden="true">
            {signingOut ? (
              <LoaderCircle className={styles.spinner} size={16} strokeWidth={1.75} />
            ) : (
              <LogOut size={16} strokeWidth={1.75} />
            )}
          </span>
          <span className={styles.itemLabel}>
            {signingOut ? "正在退出…" : "退出登录"}
          </span>
        </motion.button>
      </div>
    </>
  );

  const panel = (
    <AnimatePresence>
      {open && !sheet ? (
        <motion.div
          key="panel"
          ref={surfaceRef}
          {...menuProps}
          className={styles.panel}
          data-align={align}
          variants={reduced ? stillMotion : panelMotion}
          initial="closed"
          animate="open"
          exit="exit"
        >
          {content}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  const bottomSheet = (
    <AnimatePresence>
      {open && sheet ? (
        <motion.div
          key="scrim"
          className={styles.scrim}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.1 : 0.2, ease: standard }}
          onClick={() => close(true)}
        />
      ) : null}
      {open && sheet ? (
        <motion.div
          key="sheet"
          ref={surfaceRef}
          {...menuProps}
          className={`${styles.panel} ${styles.sheet}`}
          aria-modal="true"
          variants={reduced ? stillMotion : sheetMotion}
          initial="closed"
          animate="open"
          exit="exit"
          drag={reduced ? false : "y"}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0.04, bottom: 0.9 }}
          dragMomentum={false}
          onDragEnd={onDragEnd}
        >
          <span className={styles.handle} aria-hidden="true" />
          {content}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <span ref={rootRef} className={styles.root}>
      <button
        ref={setTriggerRef}
        id={triggerId}
        type="button"
        className={[styles.trigger, className].filter(Boolean).join(" ")}
        data-state={open ? "open" : "closed"}
        data-name={showName || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`账号菜单，${user.name}`}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
      >
        <Portrait name={user.name} size="sm" />
        {showName ? (
          <>
            <span className={styles.triggerName}>{user.name}</span>
            <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
          </>
        ) : null}
      </button>
      {sheet ? createPortal(bottomSheet, document.body) : hydrated ? createPortal(panel, document.body) : null}
    </span>
  );
}


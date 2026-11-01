"use client";

import { Fragment, forwardRef, useId, useState } from "react";
import type { AriaAttributes, ComponentPropsWithoutRef, CSSProperties } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Variants } from "motion/react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./select.module.css";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

export interface SelectProps extends Omit<ComponentPropsWithoutRef<typeof SelectPrimitive.Root>, "children"> {
  label?: string;
  description?: string;
  placeholder?: string;
  id?: string;
  className?: string;
  options: SelectOption[];
  /** The trigger already shows the current value; hide that same row from the
   * popup so the list only offers ALTERNATIVES. A single-option list keeps its
   * row so the popup is never empty. */
  hideSelected?: boolean;
  style?: CSSProperties;
  title?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
}

/** The shown value rolls in the direction of the list: a later option rises from below, an earlier one drops from above. */
const valueRoll: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${direction * 0.35}em`, filter: `blur(${motionTokens.blur.soft}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } },
  exit: (direction: number) => ({ opacity: 0, y: `${direction * -0.3}em`, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }),
};
/** Reduced motion keeps a short crossfade; the resting state matches valueRoll so server and client markup agree. */
const valueFade: Variants = { enter: { opacity: 0 }, center: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.instant } }, exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } } };

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { label, description, placeholder = "Select an option", options, id, className, style, title, disabled, hideSelected, onValueChange, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-invalid": ariaInvalid, ...rootProps },
  ref,
) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = description ? `${controlId}-description` : undefined;
  const reduceMotion = useReducedMotion();
  const [uncontrolledValue, setUncontrolledValue] = useState(rootProps.defaultValue ?? "");
  const currentValue = rootProps.value ?? uncontrolledValue;
  const index = options.findIndex((option) => option.value === currentValue);
  const shown = currentValue ? options[index]?.label ?? "" : placeholder;
  const [previousIndex, setPreviousIndex] = useState(index);
  const [direction, setDirection] = useState(1);
  if (previousIndex !== index) { setPreviousIndex(index); setDirection(index > previousIndex ? 1 : -1); }
  const optionGroups: { label?: string; items: SelectOption[] }[] = [];
  for (const option of options) {
    const previous = optionGroups.at(-1);
    if (!previous || previous.label !== option.group) optionGroups.push({ label: option.group, items: [option] });
    else previous.items.push(option);
  }
  const visibleGroups = hideSelected && options.length > 1
    ? optionGroups
        .map((group) => ({ ...group, items: group.items.filter((option) => option.value !== currentValue) }))
        .filter((group) => group.items.length > 0)
    : optionGroups;

  return (
    <div className={styles.field}>
      {label ? <label htmlFor={controlId}>{label}</label> : null}
      <SelectPrimitive.Root {...rootProps} disabled={disabled} onValueChange={(next) => { setUncontrolledValue(next); onValueChange?.(next); }}>
        <SelectPrimitive.Trigger
          ref={ref}
          id={controlId}
          title={title}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-invalid={ariaInvalid}
          aria-describedby={hintId}
          style={style}
          className={[styles.trigger, className].filter(Boolean).join(" ")}
        >
          {/* Radix keeps the real value for assistive tech; the visible copy below animates between values. Hidden-from-list selections still announce
              their label because the text is supplied explicitly. */}
          <span className={styles.srOnly}><SelectPrimitive.Value placeholder={placeholder}>{shown}</SelectPrimitive.Value></span>
          <span className={styles.valueText} aria-hidden="true">
            <AnimatePresence initial={false} custom={direction}>
              <motion.span key={currentValue ? `value-${currentValue}` : "placeholder"} data-placeholder={currentValue ? undefined : ""} custom={direction} variants={reduceMotion ? valueFade : valueRoll} initial="enter" animate="center" exit="exit">{shown}</motion.span>
            </AnimatePresence>
          </span>
          <SelectPrimitive.Icon className={styles.chevron}>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content className={styles.content} position="popper" sideOffset={4} collisionPadding={12}>
            <SelectPrimitive.ScrollUpButton className={styles.scrollButton}>
              <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className={styles.viewport}>
              {visibleGroups.map((group, groupIndex) => {
                const items = group.items.map((option) => <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className={styles.item}>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className={styles.indicator}>
                    <Check size={16} strokeWidth={1.75} aria-hidden="true" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>);
                return group.label ? <SelectPrimitive.Group key={group.label}>
                  <SelectPrimitive.Label className={styles.groupLabel}>{group.label}</SelectPrimitive.Label>
                  {items}
                </SelectPrimitive.Group> : <Fragment key={`options-${groupIndex}`}>{items}</Fragment>;
              })}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className={styles.scrollButton}>
              <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {description && <span id={hintId} className={styles.hint}>{description}</span>}
    </div>
  );
});

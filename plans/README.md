# Animation Plans

Plans 001–004 were stamped with HEAD commit `f1632bf`; plans 011–017 with
`e01240f`. The working tree already contained extensive local changes when the
first batch was written, and the source excerpts reflect the on-disk files at
their stamp time. Reconcile each excerpt against the executor's actual source
before editing; if an excerpt no longer matches, STOP and report instead of
improvising. These files are read-only implementation plans; source code has
not been changed by the planning tasks.

Reconcile note (2026-10-16, stamp `e01240f`): the 2026-10-16 Radix migration
landed after 001–004 were written. Verified against the current tree: 001's
surface rule exists (`.trace-panel`, `index.css:321-331`); 003's and 004's hook
attributes exist (`Thread.tsx:176`, `TraceSteps.tsx:32`) but their base motion
rules were never landed, leaving their reduced-motion entries
(`index.css:715-734`) as forward references; 002's hook attribute
(`data-motion="feedback-reason"`) no longer exists anywhere — the reason
picker is a Radix Popover now (`Thread.tsx:622-659`), so 002 must be rewritten
against that surface before execution. Plan 011 deletes the two fully orphaned
reduced-motion groups (feedback-reason, t-trace-marker/fill) and the dead
native-dialog/native-popover CSS.

| # | Plan | Severity | Status | Depends on |
|---|---|---|---|---|
| 001 | [Add a spatial TracePanel transition](001-trace-panel-spatial-transition.md) | MEDIUM | DONE (rule live at `index.css:321-331` + RM `:698-704`) | None |
| 002 | [Animate the feedback reason popover](002-feedback-reason-picker-transition.md) | MEDIUM | STALE — surface attribute gone; rewrite against the Radix Popover before executing | None |
| 003 | [Bridge attachment chip removal](003-attachment-chip-exit-transition.md) | MEDIUM | TODO — hook attribute live, base rule missing; reconcile excerpts first | None |
| 004 | [Make trace status changes legible](004-trace-step-status-transition.md) | MEDIUM | TODO — hook attribute live, base rule missing; reconcile excerpts first | None |
| 011 | [Delete dead native-surface motion CSS](011-delete-dead-native-surface-motion-css.md) | LOW | DONE 2026-10-17 | None |
| 012 | [Close the two global motion-guard gaps](012-close-motion-guard-gaps.md) | MEDIUM | DONE 2026-10-17 | 011 |
| 013 | [Put tw-animate surfaces on repo tokens](013-tw-animate-token-alignment.md) | LOW | DONE 2026-10-17 | None |
| 014 | [Explicit transition property lists](014-explicit-transition-property-lists.md) | LOW | DONE 2026-10-17 | None |
| 015 | [Animate bare Collapsible disclosures](015-animate-bare-collapsible-disclosures.md) | MEDIUM | DONE 2026-10-17 | 012, 013 |
| 016 | [Grow the sidebar folder tree](016-sidebar-folder-tree-reveal.md) | LOW | DONE 2026-10-17 | 011 |
| 017 | [Import progress color transitions](017-import-progress-color-transitions.md) | LOW | DONE 2026-10-17 | None |

## 2026-10-17 execution record

011–017 executed serially in the working tree (no commits — the user commits
per ticket). Verification: `tsc -p tsconfig.web.json --noEmit` exit 0;
`vite build` exit 0 (with the repo's TMP/TEMP override); built CSS greps per
plan all pass, including `.ease-out{--tw-ease:var(--ease-out)}` (013 main
branch), zero `dialog{`/`[popover]`/`message-in`/`suggestion-in` (011), the
accordion 1ms reduced-motion rule and `.trace-panel` in the keyboard gate
(012), and the `.sidebar-folder-tree` base + reduced-motion rules (016);
`node --import tsx --test src/frontend/app.contract.test.ts` 27/27.
Mechanism feel-readings come from the HeadlessChrome 155 draft replicas in
`.scratch/animation-opportunities-2026-10-16/` (accordion 0→111px@62ms,
grid-rows 0→69px@62ms, color midpoint @62ms). Live-app feel checks (slow-mo
in DevTools, reduced-motion emulation on the real surfaces) remain for the
user's eye — they need the running app and were not executed here.

## Recommended execution order

1. **011 Dead CSS** — pure deletion; shrinks the file every later plan edits
   and retires the September stuck-`display` bug carrier.
2. **012 Guard gaps** — adds the reduced-motion accordion group and the
   keyboard-gate `.trace-panel` entry; must precede 015 so the new accordion
   sites are covered from their first render.
3. **013 Token alignment** — fixes the exemplar string (easing + 150ms) that
   015 then consolidates into the primitive.
4. **015 Collapsible disclosures** — five surfaces inherit the recipe.
5. **003 / 004 (after a reconcile pass)** — restore the chip exit bridge and
   the trace status transition their orphan RM entries already anticipate.
6. **014, 016, 017** — mutually independent; 016 shares `index.css` with
   011/012, so run it after them. 002 only after its rewrite.

Run `npm run typecheck:web` and `npm run build:web` after each plan, then
perform that plan's feel-check before starting the next one. Plans touching
`index.css` (011, 012, 016) must run serially, never in parallel worktrees.

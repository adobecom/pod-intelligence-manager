import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #112 — "feat(DataTable): horizontal edge scroll assist for wide tables"
 *   Parent:  b2356bd3768cf787026f822578b3c3a6f9110034
 *   Merge:   72bfb3dec60c4e75ec730ed5f46c6d3ed2efff83
 *
 * Why this PR was chosen:
 *   - Sizeable but contained feature add: wraps the existing
 *     <div className="custom-data-table"> with a DataTableScrollRegion
 *     that drives proximity-based horizontal auto-scroll via
 *     requestAnimationFrame, respects prefers-reduced-motion, and excludes
 *     sticky-right header width from the right edge zone so actions stay
 *     clickable. Tests whether the model adds the new hook imports, the
 *     wrapper component, and the layoutKey memo without breaking the
 *     existing table render or duplicating sticky-class logic.
 */

const SOURCE_FILE = `// web-src/src/components/shared/DataTable.tsx — relevant excerpts at parent b2356bd

/*
* <license header>
*/

import React, { useState, useMemo, useCallback } from 'react'
import { ActionButton, Text } from '@react-spectrum/s2'
import { style } from '@react-spectrum/s2/style' with { type: 'macro' }
// ...other icon imports

// ...TableColumn / TableAction / DataTableProps unchanged

export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  actions,
  emptyState,
  isLoading = false,
  getItemKey,
  pageSize = 20,
  onVisibleItemsChange,
  renderExpandedContent,
  expandedKeys,
  onToggleExpand
}: DataTableProps<T>): React.ReactElement {
  // ...pagination / sort / expand state and memos unchanged

  // Must define all hooks before any conditional returns (Rules of Hooks)
  const allColumns = React.useMemo(() => {
    const cols = [...columns]
    if (actions && actions.length > 0) {
      cols.push({ key: 'actions', name: 'Actions', sortable: false, cellNoWrap: true })
    }
    return cols
  }, [columns, actions])

  const totalColumnCount = allColumns.length + (isExpandable ? 1 : 0)

  // Get sticky column classes
  const getStickyClass = (columnKey: string): string => {
    const stickyColumns = allColumns.filter(c => c.isSticky).reverse()
    const index = stickyColumns.findIndex(c => c.key === columnKey)
    if (index === -1) return ''
    return \`sticky-right-\${index + 1}\`
  }

  // ...renderCell + empty-state early return unchanged

  return (
    <div data-testid="data-table" className={style({ display: 'flex', flexDirection: 'column', gap: 12, height: '[100%]', width: '[100%]' })}>
      <div className="custom-data-table" style={{ overflowX: 'auto', width: '100%', maxWidth: '100%' }}>
        <table>
          {/* thead / tbody render unchanged */}
        </table>
      </div>

      {/* Pagination */}
      {/* ...unchanged */}
    </div>
  )
}
`;

const ISSUE_TEXT = `feat(DataTable): horizontal edge scroll assist for wide tables.

Mouse users on wide DataTable instances (Events/Series dashboards) cannot
easily scroll horizontally with just a mouse. Add an edge-proximity
auto-scroll on top of the existing horizontal overflow without breaking
sticky-right columns or violating prefers-reduced-motion.

Requirements:

1. Introduce a new internal component DataTableScrollRegion(props: { children, layoutKey })
   that wraps the existing horizontal scroll container. The existing
   <div className="custom-data-table"> stays as the inner scroll element;
   the new component sits one level above it as a "shell".
2. On the shell, attach onMouseMove and onMouseLeave handlers. While the
   cursor is within EDGE_ZONE_PX (use 56) of the left or right edge,
   integrate a velocity (capped at MAX_SCROLL_SPEED_PX_PER_S, use 1400)
   into scrollLeft via requestAnimationFrame. Velocity scales linearly
   with distance to the edge.
3. Right-edge math must subtract the summed width of all sticky-right
   <th> headers (selector \`thead th[class*="sticky-right"]\`) so the
   auto-scroll never engages over sticky actions/headers, and a right
   edge gradient (hint) is positioned with \`right: stickyReservedWidth\`.
4. Render two aria-hidden gradient hints
   (.data-table-scroll-hint-left, .data-table-scroll-hint-right) whose
   opacity is 0 when no horizontal overflow exists on that side. Use a
   small SCROLL_EPSILON (use 2) when comparing scrollLeft to
   (scrollWidth - clientWidth).
5. Honor prefers-reduced-motion: reduce by disabling auto-scroll
   (velocity 0, no rAF) and listening for matchMedia change events.
6. Use ResizeObserver on the inner scroll root and the inner <table> to
   re-measure sticky width and refresh hint opacity. Also listen to
   scroll on the inner element for hint updates.
7. In DataTable, compute a memoized layoutKey from the column keys,
   widths, isSticky flags, isExpandable, and actions count, and pass it
   to the scroll region so measurements re-run when columns change.

Do not change column sort, pagination, expand, or empty-state behavior.
Do not change any existing CSS-class names other than adding the new
shell/hint class names.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/components/shared/DataTable.tsx
+++ b/web-src/src/components/shared/DataTable.tsx
@@ -2,7 +2,7 @@
 * <license header>
 */

-import React, { useState, useMemo, useCallback } from 'react'
+import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
 import { ActionButton, Text } from '@react-spectrum/s2'
 import { style } from '@react-spectrum/s2/style' with { type: 'macro' }
 import Sort from "@react-spectrum/s2/icons/Sort"
@@ -56,6 +56,214 @@ const iconMap = {
   delete: RemoveCircle
 }

+const EDGE_ZONE_PX = 56
+const MAX_SCROLL_SPEED_PX_PER_S = 1400
+const SCROLL_EPSILON = 2
+
+function sumStickyRightHeaderWidths(scrollRoot: HTMLElement): number {
+  const headers = scrollRoot.querySelectorAll<HTMLElement>('thead th[class*="sticky-right"]')
+  let sum = 0
+  headers.forEach((th) => {
+    sum += th.offsetWidth
+  })
+  return sum
+}
+
+interface DataTableScrollRegionProps {
+  children: React.ReactNode
+  /** Bumps measurement when columns / structure change */
+  layoutKey: string
+}
+
+/**
+ * Proximity horizontal auto-scroll + edge gradients for mouse users.
+ * Right-edge math excludes sticky-right header width so actions stay clickable.
+ */
+function DataTableScrollRegion({ children, layoutKey }: DataTableScrollRegionProps): React.ReactElement {
+  const shellRef = useRef<HTMLDivElement>(null)
+  const scrollRef = useRef<HTMLDivElement>(null)
+  const leftHintRef = useRef<HTMLDivElement>(null)
+  const rightHintRef = useRef<HTMLDivElement>(null)
+  const velocityRef = useRef(0)
+  const rafRef = useRef<number | null>(null)
+  const lastTickRef = useRef(0)
+  const reduceMotionRef = useRef(false)
+  const [stickyReservedWidth, setStickyReservedWidth] = useState(0)
+
+  useEffect(() => {
+    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
+    reduceMotionRef.current = mq.matches
+    const onChange = () => {
+      reduceMotionRef.current = mq.matches
+      if (mq.matches) {
+        velocityRef.current = 0
+      }
+    }
+    mq.addEventListener('change', onChange)
+    return () => mq.removeEventListener('change', onChange)
+  }, [])
+
+  const updateHintOpacity = useCallback(() => {
+    const el = scrollRef.current
+    const leftEl = leftHintRef.current
+    const rightEl = rightHintRef.current
+    if (!el || !leftEl || !rightEl) return
+
+    const maxScroll = el.scrollWidth - el.clientWidth
+    const hasOverflow = maxScroll > SCROLL_EPSILON
+    const sl = el.scrollLeft
+
+    const leftOp = hasOverflow && sl > SCROLL_EPSILON ? 1 : 0
+    const rightOp = hasOverflow && sl < maxScroll - SCROLL_EPSILON ? 1 : 0
+    leftEl.style.opacity = String(leftOp)
+    rightEl.style.opacity = String(rightOp)
+  }, [])
+
+  const measureSticky = useCallback(() => {
+    const root = scrollRef.current
+    if (!root) return
+    const raw = sumStickyRightHeaderWidths(root)
+    const clamped = Math.min(Math.max(0, raw), root.clientWidth)
+    setStickyReservedWidth(clamped)
+  }, [])
+
+  useLayoutEffect(() => {
+    measureSticky()
+    updateHintOpacity()
+  }, [layoutKey, measureSticky, updateHintOpacity])
+
+  useEffect(() => {
+    const root = scrollRef.current
+    if (!root) return
+
+    const ro = new ResizeObserver(() => {
+      measureSticky()
+      updateHintOpacity()
+    })
+    ro.observe(root)
+    const table = root.querySelector('table')
+    if (table) {
+      ro.observe(table)
+    }
+
+    const onScroll = () => updateHintOpacity()
+    root.addEventListener('scroll', onScroll, { passive: true })
+
+    return () => {
+      ro.disconnect()
+      root.removeEventListener('scroll', onScroll)
+    }
+  }, [layoutKey, measureSticky, updateHintOpacity])
+
+  const runTick = useCallback(() => {
+    const el = scrollRef.current
+    if (!el) {
+      rafRef.current = null
+      return
+    }
+
+    const now = performance.now()
+    if (lastTickRef.current === 0) {
+      lastTickRef.current = now
+    }
+    const dt = Math.min(0.1, (now - lastTickRef.current) / 1000)
+    lastTickRef.current = now
+
+    const v = reduceMotionRef.current ? 0 : velocityRef.current
+    if (v !== 0) {
+      el.scrollLeft += v * dt
+    }
+    updateHintOpacity()
+
+    if (velocityRef.current !== 0 && !reduceMotionRef.current) {
+      rafRef.current = requestAnimationFrame(runTick)
+    } else {
+      rafRef.current = null
+      lastTickRef.current = 0
+    }
+  }, [updateHintOpacity])
+
+  const ensureTick = useCallback(() => {
+    if (rafRef.current == null && velocityRef.current !== 0 && !reduceMotionRef.current) {
+      rafRef.current = requestAnimationFrame(runTick)
+    }
+  }, [runTick])
+
+  const handleMouseMove = useCallback(
+    (e: React.MouseEvent<HTMLDivElement>) => {
+      const shell = shellRef.current
+      if (!shell || !scrollRef.current || reduceMotionRef.current) {
+        velocityRef.current = 0
+        return
+      }
+
+      const rect = shell.getBoundingClientRect()
+      const stickyW = stickyReservedWidth
+      const effectiveRight = rect.right - stickyW
+
+      const distLeft = e.clientX - rect.left
+      const distRight = effectiveRight - e.clientX
+
+      let vLeft = 0
+      let vRight = 0
+      if (distLeft >= 0 && distLeft < EDGE_ZONE_PX) {
+        vLeft = -MAX_SCROLL_SPEED_PX_PER_S * (1 - distLeft / EDGE_ZONE_PX)
+      }
+      if (distRight >= 0 && distRight < EDGE_ZONE_PX && e.clientX < effectiveRight) {
+        vRight = MAX_SCROLL_SPEED_PX_PER_S * (1 - distRight / EDGE_ZONE_PX)
+      }
+
+      if (vLeft !== 0 && vRight !== 0) {
+        velocityRef.current = Math.abs(vLeft) >= Math.abs(vRight) ? vLeft : vRight
+      } else {
+        velocityRef.current = vLeft + vRight
+      }
+
+      if (velocityRef.current !== 0) {
+        ensureTick()
+      }
+    },
+    [ensureTick, stickyReservedWidth]
+  )
+
+  const handleMouseLeave = useCallback(() => {
+    velocityRef.current = 0
+    updateHintOpacity()
+  }, [updateHintOpacity])
+
+  useEffect(() => {
+    return () => {
+      if (rafRef.current != null) {
+        cancelAnimationFrame(rafRef.current)
+      }
+    }
+  }, [])
+
+  return (
+    <div
+      ref={shellRef}
+      className="data-table-scroll-shell"
+      onMouseMove={handleMouseMove}
+      onMouseLeave={handleMouseLeave}
+    >
+      <div
+        ref={scrollRef}
+        className="custom-data-table"
+        style={{ overflowX: 'auto', width: '100%', maxWidth: '100%' }}
+      >
+        {children}
+      </div>
+      <div ref={leftHintRef} className="data-table-scroll-hint-left" aria-hidden />
+      <div
+        ref={rightHintRef}
+        className="data-table-scroll-hint-right"
+        style={{ right: stickyReservedWidth, width: EDGE_ZONE_PX }}
+        aria-hidden
+      />
+    </div>
+  )
+}
+
 export function DataTable<T extends Record<string, any>>({
   columns,
   data,
@@ -232,6 +440,12 @@ export function DataTable<T extends Record<string, any>>({

   const totalColumnCount = allColumns.length + (isExpandable ? 1 : 0)

+  const scrollLayoutKey = useMemo(
+    () =>
+      \`\${allColumns.map((c) => \`\${c.key}:\${c.width ?? ''}:\${c.isSticky ? 1 : 0}\`).join('|')}|e:\${isExpandable ? 1 : 0}|a:\${actions?.length ?? 0}\`,
+    [allColumns, isExpandable, actions?.length]
+  )
+
   // Get sticky column classes
   const getStickyClass = (columnKey: string): string => {
     const stickyColumns = allColumns.filter(c => c.isSticky).reverse()
@@ -276,7 +490,7 @@ export function DataTable<T extends Record<string, any>>({

   return (
     <div data-testid="data-table" className={style({ display: 'flex', flexDirection: 'column', gap: 12, height: '[100%]', width: '[100%]' })}>
-      <div className="custom-data-table" style={{ overflowX: 'auto', width: '100%', maxWidth: '100%' }}>
+      <DataTableScrollRegion layoutKey={scrollLayoutKey}>
         <table>
           <thead>
             <tr>
@@ -404,7 +618,7 @@ export function DataTable<T extends Record<string, any>>({
             })}
           </tbody>
         </table>
-      </div>
+      </DataTableScrollRegion>

       {/* Pagination */}
       {totalPages > 1 && (
`;

export const datatableHorizontalEdgeScroll: Task = {
  id: "real-emc-datatable-horizontal-edge-scroll",
  type: "content",
  podId: "pod-emc-configs",
  asOf: "2026-04-02T12:17:29-07:00",
  tags: ["real-emc", "ui", "datatable", "a11y"],
  // Re-tiered to realistic-ticket (#8): saturated checklist + pasted source removed.
  prompt: [
    "# Issue",
    "feat(DataTable): horizontal edge scroll assist for wide tables",
    "",
    "Mouse-only users on wide DataTable instances (Events/Series dashboards) can't",
    "easily scroll horizontally — there's a horizontal overflow but no affordance to",
    "drag/scroll it with a mouse. Add an edge-proximity auto-scroll: when the cursor",
    "nears the left or right edge of the table viewport, the table scrolls in that",
    "direction, faster the closer you get to the edge.",
    "",
    "Constraints:",
    "- Don't break the sticky-right columns (the actions column must stay clickable —",
    "  auto-scroll should not engage over it).",
    "- Honor prefers-reduced-motion: users with that set should get no auto-scroll.",
    "- Show a subtle gradient hint on a side only when there's actually more content",
    "  to scroll to on that side.",
    "- Don't change sort, pagination, expand, or empty-state behavior, and don't",
    "  rename existing CSS classes.",
    "",
    "The component lives at `web-src/src/components/shared/DataTable.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the DataTable component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "DataTableScrollRegion",
    "requestAnimationFrame",
    "prefers-reduced-motion",
    "sticky-right",
    "ResizeObserver",
    "EDGE_ZONE_PX",
    "MAX_SCROLL_SPEED_PX_PER_S",
    "layoutKey",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #112, merge SHA 72bfb3d. Parent file at b2356bd.",
  },
  rubric: {
    id: "real-emc-datatable-horizontal-edge-scroll-v1",
    criteria: [
      {
        id: "introduces_scroll_region_wrapper",
        description:
          "Does the patch introduce a DataTableScrollRegion (or equivalently named) component that wraps the existing `<div className=\"custom-data-table\">` so the inner overflow-x scroll element is preserved? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "rAF_velocity_with_caps",
        description:
          "Does the implementation drive scrollLeft via requestAnimationFrame using a velocity that scales with distance to the edge and is bounded by a cap (1400 px/s) and an edge zone (56 px), rather than naively setting scrollLeft on every mouse move? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "excludes_sticky_right_from_right_edge",
        description:
          "Does the right-edge math subtract the summed width of `thead th[class*=\"sticky-right\"]` headers and inset the right gradient hint by that width so auto-scroll does not engage over sticky-right actions? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "respects_reduced_motion",
        description:
          "Does the component check `window.matchMedia('(prefers-reduced-motion: reduce)')`, listen for its change events, and disable auto-scroll (no rAF, velocity 0) when reduce is active? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "hint_opacity_reflects_overflow",
        description:
          "Are the two aria-hidden left/right hint nodes rendered with their opacity driven by current scrollLeft vs (scrollWidth - clientWidth) using a small epsilon (e.g., 2), and updated on scroll/resize? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "layout_key_memo_threaded",
        description:
          "Does the DataTable compute a memoized layoutKey from column keys, widths, isSticky flags, isExpandable, and actions count, and pass it to the scroll region so measurements re-run on column changes? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "valid_unified_diff_no_regression",
        description:
          "Is the output a parseable unified diff with --- / +++ / @@ headers and proper +/- prefixes, and does it leave the inner <table> markup, sticky-class logic, sort, pagination, and empty-state early return unchanged? Score 0-5.",
        scale: "0-5",
        weight: 1,
      },
    ],
  },
};

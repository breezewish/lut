# Interface Design Context

## Direction

RAW Alchemy is a precise, flat editing workspace. Its visual language is neutral, compact, and calm so photographs remain dominant. The shell uses no decorative borders, shadows, gradients, or glass effects. A restrained spectral-blue accent identifies selection, active values, and primary actions; amber is reserved for the unverified LUT output assumption.

## Theme

The application supports persistent Light and Dark modes. Light mode uses a bright neutral shell with a mid-gray canvas; Dark mode uses near-black neutral surfaces. Both modes keep the image wells dark and neutral for consistent color judgment. Theme changes update the browser chrome color and never affect image processing.

## Information Architecture

Desktop uses a stable editing shell:

- The top toolbar owns app identity, the active document, local-privacy status, theme, import, and batch export.
- The left queue owns local source files and their processing state.
- The center canvas owns Base and LUT comparison and remains the largest surface.
- The right inspector owns adjustments first and output second.
- A compact status bar discloses processing assumptions without competing with the images.

The DOM follows the task order: adjust, compare, then export. Empty state keeps one primary import action in the canvas and a secondary queue drop target.

## Color

All color tokens use OKLCH. Neutral surfaces carry structure through value differences rather than outlines. Spectral blue is limited to primary actions, selection, and active state. Green indicates local privacy or completion, red indicates failure, and amber indicates an unverified color assumption. Text and placeholders meet WCAG AA contrast.

## Typography

Use one Inter-compatible system sans family. UI labels and metadata use a compact fixed scale from 10 to 14 px; the empty-state title reaches 18 px. Numeric exposure values use tabular figures. Product headings are short, balanced, and never use display typography.

## Components

Buttons use a consistent 6 px radius and 32–36 px desktop body; coarse-pointer targets expand to 44 px. Inputs use a compact 30–34 px body inside clear labeled groups. Search, selection, numeric entry, and range controls share dedicated control tokens and authored hover, focus, active, and disabled states instead of browser defaults. Menus render through a portal. A visible spinner in the adjustment header communicates whenever the displayed recipe is still processing. Surfaces use fill changes instead of borders or shadows.

Progressive preview buffers never define layout size. Every preview Canvas fills a stable image well, so 256 px edit frames, 384 px initial frames, and 1024 px settled frames change clarity without changing geometry. Native exposure input paints independently while interruptible React transitions submit the latest preview recipe at a bounded rate.

## Motion

State transitions complete within 160–220 ms using ease-out curves. Motion communicates hover, selection, processing, or loading only. Reduced-motion preferences reduce all nonessential transitions and animation to an instant change.

## Responsive Behavior

At medium widths, the queue becomes a horizontal source strip while comparison remains side by side and the inspector remains visible. Below 700 px, the layout becomes a vertical workflow: queue, adjustments, comparison, and output. Base and LUT previews stack only below 560 px. Mobile retains full-size action targets while keeping inputs visually compact.

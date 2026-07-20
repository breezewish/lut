# Interface Design Context

## Direction

LUTify is a precise, flat editing workspace. Its visual language is neutral, compact, and calm so photographs remain dominant. The shell uses no decorative borders, shadows, gradients, or glass effects. A restrained spectral-blue accent identifies selection, active values, and primary actions; amber is reserved for the unverified LUT output assumption.

## Theme

The application supports persistent Light and Dark modes. Light mode uses a bright neutral shell with a mid-gray canvas; Dark mode uses near-black neutral surfaces. Both modes keep the image wells dark and neutral for consistent color judgment. Theme changes update the browser chrome color and never affect image processing.

## Information Architecture

Desktop uses a stable editing shell:

- The top toolbar owns app identity, active document and camera metadata, local-privacy status, theme, and import.
- The center canvas owns Base and LUT comparison and remains the largest surface.
- The right inspector owns adjustments first and output second.
- The bottom filmstrip owns local source files and their processing state.

The task order is adjust, compare, then export in visual flow; the canvas stays the dominant surface regardless of DOM position. Adjust and export controls form one contiguous inspector landmark ahead of the canvas in DOM order, so keyboard and screen-reader users traverse them as a single group. Empty state keeps one primary import action in the canvas and a secondary queue drop target.

## Color

All color tokens use OKLCH. Neutral surfaces carry structure through value differences rather than outlines. Text uses exactly two tones (ink, muted) verified at or above 4.5:1 contrast against every surface; a third neutral is reserved for non-text decoration (hairlines, ticks) and never carries text. Spectral blue is limited to primary actions, selection, and active state. Green indicates local privacy or completion, red indicates failure, and amber indicates an unverified color assumption. Text and placeholders meet WCAG AA contrast.

## Typography

Use one Inter-compatible system sans family. Meaningful UI labels and metadata use a compact fixed scale from 11 to 14 px; the empty-state title reaches 18 px. Numeric exposure values use tabular figures. Product headings are short, balanced, and never use display typography.

## Components

Buttons use a consistent 6 px radius and 32–36 px desktop body; coarse-pointer targets expand to 44 px. Inputs use a compact 30–34 px body inside clear labeled groups. Search, selection, numeric entry, and range controls share dedicated control tokens and authored hover, focus, active, and disabled states instead of browser defaults. Menus render through a portal. A visible spinner in the adjustment header communicates whenever the displayed recipe is still processing. Surfaces use fill changes instead of borders or shadows. Queue status is conveyed per-item by an icon and row fill, not a colored accent stripe.

Look discovery uses a stable searchable thumbnail catalog. Every tile is rendered from a dedicated 132px preview at the active EV. Export uses one self-labeled split button without a repeated section heading: the main segment exports and the trailing segment chooses TIFF or JPEG.

The six most recently used photos retain decoded WebGPU preview sources, while the three most recent retain their latest comparison and Look thumbnails in UI memory. One serialized renderer shares its LUT, output, and readback workspace across those sources. Returning to a retained source never reads or decodes the RAW again; a UI-retained photo restores its exact visible recipe immediately. Full-resolution export remains uncached and sequential.

Progressive preview buffers never define layout size. Every preview Canvas fills a stable image well, so 384px initial frames, 256px interaction frames, and 1024px settled frames change clarity without changing geometry. Native exposure input paints independently while render completion applies latest-only backpressure; pointer release or an 80ms idle period requests one settled frame even while the pointer remains down. LUT selection likewise paints a 256px Look before its 1024px refinement while retaining the Base pane.

Wipe and Split comparison reuse the existing Canvas buffers without starting image processing. Wipe changes one CSS clipping variable through pointer or keyboard input; Split places both complete frames side by side.

## Motion

State transitions complete within 160–220 ms using ease-out curves. Motion communicates hover, selection, processing, or loading only. Reduced-motion preferences reduce all nonessential transitions and animation to an instant change.

## Responsive Behavior

At medium widths, comparison remains dominant and the inspector stacks below it while the source filmstrip stays horizontal. The filmstrip becomes shorter on narrow screens so the compact export action remains reachable. Mobile retains 44 px action targets while keeping inputs visually compact.

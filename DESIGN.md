# Interface Design Context

## Direction

RAW Alchemy is a precise, flat editing workspace. Its visual language is neutral, compact, and calm so photographs remain dominant. The shell uses no decorative borders, shadows, gradients, or glass effects. A restrained rose accent identifies selection and primary actions; amber is reserved for the unverified LUT output assumption.

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

All color tokens use OKLCH. Neutral surfaces carry structure through value differences rather than outlines. Rose is limited to primary actions, selection, and active state. Green indicates local privacy or completion, red indicates failure, and amber indicates an unverified color assumption. Text and placeholders meet WCAG AA contrast.

## Typography

Use one Inter-compatible system sans family. UI labels and metadata use a compact fixed scale from 10 to 14 px; the empty-state title reaches 18 px. Numeric exposure values use tabular figures. Product headings are short, balanced, and never use display typography.

## Components

Buttons use a consistent 8 px radius and a minimum 44 px target. Inputs use a visually compact 36 px body inside clear labeled groups. Menus render through a portal. Controls expose hover, focus, active, disabled, loading, error, and selected states where applicable. Surfaces use fill changes instead of borders or shadows.

## Motion

State transitions complete within 160–220 ms using ease-out curves. Motion communicates hover, selection, processing, or loading only. Reduced-motion preferences reduce all nonessential transitions and animation to an instant change.

## Responsive Behavior

At medium widths, the queue becomes a horizontal source strip while comparison remains side by side and the inspector remains visible. Below 700 px, the layout becomes a vertical workflow: queue, adjustments, comparison, and output. Base and LUT previews stack only below 560 px. Mobile retains full-size action targets while keeping inputs visually compact.

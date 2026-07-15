# Interface Design Context

## Direction

RAW Alchemy uses a modern, flat dark editing environment. True neutral backgrounds protect color judgment. Raised surfaces separate queue, controls, and canvas without borders or shadows. A restrained rose primary color marks selection and primary actions; amber is reserved for the LUT output assumption.

## Hierarchy

The current images are the primary content. The queue establishes file context, processing controls form one editing group before comparison, and file metadata plus export form one output group after comparison. Empty state onboarding has one primary chooser in the workspace; the desktop queue remains a compact secondary drop target.

## System

- Typography: Inter-compatible system sans serif, compact labels, tabular numeric EV output.
- Spacing: 4, 8, 12, 16, 24, 32, and 48 px tokens.
- Targets: every interactive target is at least 44 px.
- Motion: short state transitions only; reduced-motion removes nonessential animation.
- Responsive behavior: desktop uses a fixed queue and side-by-side previews; the queue becomes horizontal on medium screens; previews stack only below 35rem.

Implementation details live in `web/src/styles.css` and reusable controls in `web/src/components/ui/`.

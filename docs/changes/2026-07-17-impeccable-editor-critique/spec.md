# Impeccable Editor Critique Specification

## Goal

Resolve the confirmed usability gaps from the independent design and browser-evidence critique without weakening the editor's restrained visual system or processing guarantees.

## Requirements

- Provide synchronized Fit and 1:1-preview inspection with pointer panning and keyboard access.
- Reduce immediate Look choices to a current/recent working set while retaining searchable access to all 27 transforms.
- Explain built-in Look processing and output color-space risk in actionable language.
- Use one switchable comparison pane below 560px and keep visible mobile targets at least 44px.
- Keep meaningful metadata at a readable 11px or larger.

## Non-goals

- 1:1 preview does not perform or imply a full-resolution RAW decode.
- Look thumbnails are not generated eagerly because doing so would add 27 render decisions and compete with the active edit.

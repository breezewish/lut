# Preview UI Polish

## Introduction

Progressive preview rendering must feel stable and its pending state must be explicit. Adjustment controls must use one deliberate product UI language instead of browser-default form styles.

## Requirements

- Progressive preview resolutions never change the displayed preview geometry.
- EV and LUT changes show a processing spinner until the exact settled recipe is visible.
- Canvas status never reports Ready while the visible recipe is still processing.
- Search, selection, numeric exposure, and range controls use consistent authored states in both themes.

## Non-goals

- Changing preview resolution, color processing, or export behavior.

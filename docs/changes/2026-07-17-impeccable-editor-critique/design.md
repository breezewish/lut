# Impeccable Editor Critique Design

## Inspection

Both Canvas panes share one normalized focal point. Fit uses the existing responsive canvas geometry. The 1:1-preview mode positions each settled preview buffer at one CSS pixel per buffer pixel and updates the shared focal point during pointer panning. No processing command is issued by view changes.

## Look discovery

The inspector shows the current Look and at most four recent choices. An explicit browser reveals search and the existing grouped Radix Select. It remains expanded across selections, allowing the working set to form while the user compares results.

## Responsive presentation

Desktop retains side-by-side comparison. Below 560px, CSS keeps only the selected Base or Look pane in layout. The toolbar owns the two-choice switch and preview view controls. Narrow-viewport sizing guarantees 44px targets independently of pointer media detection.

## Guidance

The Look section explains the input transform inline. Output disclosure uses a collapsed summary followed by impact, required action, and technical rationale.

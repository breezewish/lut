# CLI Design

The CLI is a thin product adapter. Clap parses product concepts, `lutify-libraw` decodes RGB16, `lutify-core` renders the RGB16 TIFF image, and the CLI writes the returned encoded bytes. It does not duplicate color mathematics or expose LibRaw implementation settings as public flags.

The JSON success object reports status, destination, dimensions, pipeline version, and exact LibRaw release. Errors use a stable status/message shape. Color is evaluated only for text output and terminal detection.

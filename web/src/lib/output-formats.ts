import type { OutputFormat } from "../types";

interface OutputFormatDefinition {
  label: string;
  optionLabel: string;
  extension: string;
  mime: string;
}

type OutputFormatDefinitions = {
  tiff: OutputFormatDefinition;
  jpeg: OutputFormatDefinition & { jpegQuality: number };
};

export const OUTPUT_FORMATS = {
  tiff: {
    label: "TIFF",
    optionLabel: "TIFF · 16-bit",
    extension: "tif",
    mime: "image/tiff",
  },
  jpeg: {
    label: "JPEG",
    optionLabel: "JPEG · Quality 95",
    extension: "jpg",
    mime: "image/jpeg",
    jpegQuality: 95,
  },
} as const satisfies OutputFormatDefinitions &
  Record<OutputFormat, OutputFormatDefinition>;

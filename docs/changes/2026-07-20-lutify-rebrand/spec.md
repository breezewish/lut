# LUTify Rebrand Specification

## Introduction

The product is named LUTify. RAW Alchemy is a separate upstream project whose source and behavior informed migration baselines.

## Goals

- Present LUTify as the product name in every user-facing surface.
- Name project-owned modules, packages, commands, APIs, files, and runtime identifiers with the `lutify` prefix.
- Keep upstream RAW Alchemy names, repository paths, commits, and derived-baseline provenance unchanged and clearly attributed.

## Non-goals

- Renaming the upstream RAW Alchemy or V-Log Alchemy projects.
- Preserving compatibility with the former project-owned `alchemy` command, package names, C ABI, browser storage keys, or performance marks.

## Requirements

The browser title and toolbar use LUTify. The native command is `lutify`. Rust crates are `lutify-core`, `lutify-libraw`, and `lutify-cli`. The C header and symbols use `lutify`. Project-owned npm, WASM, cache, performance, temporary-file, and download identifiers use `lutify`.

The `vendor/Raw-Alchemy` submodule remains pinned under its upstream name and URL. Documentation and code that describe inherited parameters or migration baselines call it upstream RAW Alchemy and never relabel it as LUTify.

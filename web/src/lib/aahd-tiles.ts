export interface AahdTile {
  coreX: number;
  coreY: number;
  coreWidth: number;
  coreHeight: number;
  inputX: number;
  inputY: number;
  inputWidth: number;
  inputHeight: number;
  localCoreX: number;
  localCoreY: number;
}

export const AAHD_TILE_CORE_SIZE = 1024;
export const AAHD_TILE_HALO = 12;

/**
 * Splits an even Bayer image into even-aligned cores with clipped input halos.
 * Even alignment keeps packed-u16 rows independent while global coordinates
 * preserve CFA phase for every tile.
 */
export function createAahdTiles(
  width: number,
  height: number,
  coreSize = AAHD_TILE_CORE_SIZE,
  halo = AAHD_TILE_HALO,
): AahdTile[] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(coreSize) ||
    !Number.isInteger(halo) ||
    width <= 0 ||
    height <= 0 ||
    width % 2 !== 0 ||
    height % 2 !== 0 ||
    coreSize <= 0 ||
    coreSize % 2 !== 0 ||
    halo < 0 ||
    halo % 2 !== 0
  ) {
    throw new Error(
      "AAHD tiling requires positive even image, core, and halo dimensions.",
    );
  }

  const tiles: AahdTile[] = [];
  for (let coreY = 0; coreY < height; coreY += coreSize) {
    const coreHeight = Math.min(coreSize, height - coreY);
    for (let coreX = 0; coreX < width; coreX += coreSize) {
      const coreWidth = Math.min(coreSize, width - coreX);
      const inputX = Math.max(0, coreX - halo);
      const inputY = Math.max(0, coreY - halo);
      const inputRight = Math.min(width, coreX + coreWidth + halo);
      const inputBottom = Math.min(height, coreY + coreHeight + halo);
      tiles.push({
        coreX,
        coreY,
        coreWidth,
        coreHeight,
        inputX,
        inputY,
        inputWidth: inputRight - inputX,
        inputHeight: inputBottom - inputY,
        localCoreX: coreX - inputX,
        localCoreY: coreY - inputY,
      });
    }
  }
  return tiles;
}

# Fast Preview Pipeline Tests

- The production Sony benchmark measures file read, embedded JPEG, first processed 384px frame, settled 1024px frame, Canvas draws, LibRaw phases, export, and Blob boundaries for one cold and four warm runs and enforces every initial Preview budget.
- The production interaction benchmark waits for the initial 1024px frame, then enforces EV and LUT first/settled p95 budgets over the complete built-in LUT set and repeated edits.
- The quality verifier compares full-resolution export and Preview after identical display rendering for linear DNG, lossy Linear DNG, Leica Bayer DNG, rotated Leica Bayer DNG, Sony Bayer ARW, and Fujifilm X-Trans RAF inputs and emits fixed crops.
- Native and WASM LibRaw remain exact for full and half-size decode, while browser and native full-resolution TIFF exports remain within one RGB16 code.
- A real legacy Fujifilm Super CCD RAF is rejected before unpack with a concrete reliability error; modern X-Trans RAF passes the quality contract.
- Production Chromium, Firefox, WebKit, and Pages-subpath smoke tests import and display Preview; decode and export failure tests preserve their separate recovery behavior.

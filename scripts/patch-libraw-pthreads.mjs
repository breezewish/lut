import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Expected the copied LibRaw source directory");

async function replaceOnce(file, before, after) {
  const path = join(root, "src", "decoders", file);
  const source = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one pthread patch site in ${file}`);
  }
  await writeFile(path, source.replace(before, after));
}

await replaceOnce(
  "fuji_compressed.cpp",
  `  int cur_block;
  const int lineStep = (libraw_internal_data.unpacker_data.fuji_total_lines + 0xF) & ~0xF;
#ifdef LIBRAW_USE_OPENMP
  unsigned errcnt = 0;
#pragma omp parallel for private(cur_block) shared(errcnt)
#endif
  for (cur_block = 0; cur_block < count; cur_block++)
  {
    try
    {
      fuji_decode_strip(common_info, cur_block, raw_block_offsets[cur_block], block_sizes[cur_block],
                        q_bases ? q_bases + cur_block * lineStep : 0);
    }
    catch (...)
    {
#ifdef LIBRAW_USE_OPENMP
#pragma omp atomic
\t\t  errcnt++;
#else
\t\t  throw;
#endif
\t  }
  }
#ifdef LIBRAW_USE_OPENMP
  if (errcnt)
\t\t  throw LIBRAW_EXCEPTION_IO_EOF;
#endif`,
  `  const int lineStep = (libraw_internal_data.unpacker_data.fuji_total_lines + 0xF) & ~0xF;
  std::atomic<unsigned> errcnt{0};
  libraw_parallel_for(count, [&](int cur_block) {
    try
    {
      fuji_decode_strip(common_info, cur_block, raw_block_offsets[cur_block], block_sizes[cur_block],
                        q_bases ? q_bases + cur_block * lineStep : 0);
    }
    catch (...)
    {
      errcnt.fetch_add(1, std::memory_order_relaxed);
    }
  });
  if (errcnt.load(std::memory_order_relaxed))
    throw LIBRAW_EXCEPTION_IO_EOF;`,
);

await replaceOnce(
  "pana8.cpp",
  `#ifdef LIBRAW_USE_OPENMP
\tint errs = 0, scount = MIN(5,libraw_internal_data.unpacker_data.pana8.stripe_count);
#pragma omp parallel for${" "}
  for (int stream = 0; stream < scount; stream++)
  {
\t\tif (pana8_decode_strip(data, stream))
\t\t\terrs++;
  }
\tif(errs)
      throw LIBRAW_EXCEPTION_IO_CORRUPT;
#else
  for (int stream = 0; stream < libraw_internal_data.unpacker_data.pana8.stripe_count && stream < 5; stream++)
    if (pana8_decode_strip(data, stream))
      throw LIBRAW_EXCEPTION_IO_CORRUPT;
#endif`,
  `  std::atomic<unsigned> errs{0};
  const int count = MIN(5, libraw_internal_data.unpacker_data.pana8.stripe_count);
  libraw_parallel_for(count, [&](int stream) {
    if (pana8_decode_strip(data, stream))
      errs.fetch_add(1, std::memory_order_relaxed);
  });
  if (errs.load(std::memory_order_relaxed))
    throw LIBRAW_EXCEPTION_IO_CORRUPT;`,
);

await replaceOnce(
  "crx.cpp",
  `#ifdef LIBRAW_USE_OPENMP
  int results[4] ={0,0,0,0}; // nPlanes is always <= 4
#pragma omp parallel for
  for (int32_t plane = 0; plane < nPlanes; ++plane)
   try {
    results[plane] = crxDecodePlane(img, plane);
   } catch (...) {
    results[plane] = 1;
   }

  for (int32_t plane = 0; plane < nPlanes; ++plane)
    if (results[plane])
      derror();
#else
  for (int32_t plane = 0; plane < nPlanes; ++plane)
    if (crxDecodePlane(img, plane))
      derror();
#endif`,
  `  int results[4] ={0,0,0,0}; // nPlanes is always <= 4
  libraw_parallel_for(nPlanes, [&](int plane) {
    try {
      results[plane] = crxDecodePlane(img, plane);
    } catch (...) {
      results[plane] = 1;
    }
  });

  for (int32_t plane = 0; plane < nPlanes; ++plane)
    if (results[plane])
      derror();`,
);

await replaceOnce(
  "crx.cpp",
  `#ifdef LIBRAW_USE_OPENMP
#pragma omp parallel for
#endif
  for (int i = 0; i < planeHeight; ++i)
    crxConvertPlaneLineDf(p, i);`,
  `  libraw_parallel_for(planeHeight, [&](int row) {
    crxConvertPlaneLineDf(p, row);
  });`,
);

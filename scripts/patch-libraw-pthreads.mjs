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

await replaceOnce(
  "decoders_dcraw.cpp",
  `void LibRaw::sony_arw2_load_raw()
{
  uchar *data, *dp;
  ushort pix[16];
  int row, col, val, max, min, imax, imin, sh, bit, i;

  data = (uchar *)calloc(raw_width + 1,1);
  try
  {
    for (row = 0; row < height; row++)
    {
      checkCancel();
      fread(data, 1, raw_width, ifp);
      for (dp = data, col = 0; col < raw_width - 30; dp += 16)
      {
        max = 0x7ff & (val = sget4(dp));
        min = 0x7ff & val >> 11;
        imax = 0x0f & val >> 22;
        imin = 0x0f & val >> 26;
        for (sh = 0; sh < 4 && 0x80 << sh <= max - min; sh++)
          ;
        /* flag checks if outside of loop */
        if (!(imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_ALLFLAGS) // no flag set
            || (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTATOVALUE))
        {
          for (bit = 30, i = 0; i < 16; i++)
            if (i == imax)
              pix[i] = max;
            else if (i == imin)
              pix[i] = min;
            else
            {
              pix[i] =
                  ((sget2(dp + (bit >> 3)) >> (bit & 7) & 0x7f) << sh) + min;
              if (pix[i] > 0x7ff)
                pix[i] = 0x7ff;
              bit += 7;
            }
        }
        else if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_BASEONLY)
        {
          for (bit = 30, i = 0; i < 16; i++)
            if (i == imax)
              pix[i] = max;
            else if (i == imin)
              pix[i] = min;
            else
              pix[i] = 0;
        }
        else if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTAONLY)
        {
          for (bit = 30, i = 0; i < 16; i++)
            if (i == imax)
              pix[i] = 0;
            else if (i == imin)
              pix[i] = 0;
            else
            {
              pix[i] =
                  ((sget2(dp + (bit >> 3)) >> (bit & 7) & 0x7f) << sh) + min;
              if (pix[i] > 0x7ff)
                pix[i] = 0x7ff;
              bit += 7;
            }
        }
        else if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTAZEROBASE)
        {
          for (bit = 30, i = 0; i < 16; i++)
            if (i == imax)
              pix[i] = 0;
            else if (i == imin)
              pix[i] = 0;
            else
            {
              pix[i] = ((sget2(dp + (bit >> 3)) >> (bit & 7) & 0x7f) << sh);
              if (pix[i] > 0x7ff)
                pix[i] = 0x7ff;
              bit += 7;
            }
        }

        if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTATOVALUE)
        {
          for (i = 0; i < 16; i++, col += 2)
          {
            unsigned slope =
                pix[i] < 1001 ? 2
                              : curve[pix[i] << 1] - curve[(pix[i] << 1) - 2];
            unsigned step = 1 << sh;
            RAW(row, col) =
                curve[pix[i] << 1] >
                        black + imgdata.rawparams.sony_arw2_posterization_thr
                    ? LIM(((slope * step * 1000) /
                           (curve[pix[i] << 1] - black)),
                          0, 10000)
                    : 0;
          }
        }
        else
          for (i = 0; i < 16; i++, col += 2)
            RAW(row, col) = curve[pix[i] << 1];
        col -= col & 1 ? 1 : 31;
      }
    }
  }
  catch (...)
  {
    free(data);
    throw;
  }
  if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTATOVALUE)
    maximum = 10000;
  free(data);
}`,
  `void LibRaw::sony_arw2_load_raw()
{
  constexpr uint64_t max_parallel_input = 64ULL * 1024ULL * 1024ULL;
  const uint64_t packed_size_64 = static_cast<uint64_t>(raw_width) * height;
  if (packed_size_64 == 0 || packed_size_64 > max_parallel_input)
    throw LIBRAW_EXCEPTION_TOOBIG;
  const size_t packed_size = static_cast<size_t>(packed_size_64);

  std::vector<uchar> packed(packed_size);
  if (fread(packed.data(), 1, packed.size(), ifp) != packed.size())
    throw LIBRAW_EXCEPTION_IO_EOF;
  checkCancel();

  libraw_parallel_for(height, [&](int row) {
    uchar *data = packed.data() + static_cast<size_t>(row) * raw_width;
    uchar *dp;
    ushort pix[16];
    int col, val, max, min, imax, imin, sh, bit, i;

    for (dp = data, col = 0; col < raw_width - 30; dp += 16)
    {
      max = 0x7ff & (val = sget4(dp));
      min = 0x7ff & val >> 11;
      imax = 0x0f & val >> 22;
      imin = 0x0f & val >> 26;
      for (sh = 0; sh < 4 && 0x80 << sh <= max - min; sh++)
        ;
      if (!(imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_ALLFLAGS)
          || (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTATOVALUE))
      {
        for (bit = 30, i = 0; i < 16; i++)
          if (i == imax)
            pix[i] = max;
          else if (i == imin)
            pix[i] = min;
          else
          {
            pix[i] =
                ((sget2(dp + (bit >> 3)) >> (bit & 7) & 0x7f) << sh) + min;
            if (pix[i] > 0x7ff)
              pix[i] = 0x7ff;
            bit += 7;
          }
      }
      else if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_BASEONLY)
      {
        for (bit = 30, i = 0; i < 16; i++)
          if (i == imax)
            pix[i] = max;
          else if (i == imin)
            pix[i] = min;
          else
            pix[i] = 0;
      }
      else if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTAONLY)
      {
        for (bit = 30, i = 0; i < 16; i++)
          if (i == imax || i == imin)
            pix[i] = 0;
          else
          {
            pix[i] =
                ((sget2(dp + (bit >> 3)) >> (bit & 7) & 0x7f) << sh) + min;
            if (pix[i] > 0x7ff)
              pix[i] = 0x7ff;
            bit += 7;
          }
      }
      else
      {
        for (bit = 30, i = 0; i < 16; i++)
          if (i == imax || i == imin)
            pix[i] = 0;
          else
          {
            pix[i] = (sget2(dp + (bit >> 3)) >> (bit & 7) & 0x7f) << sh;
            if (pix[i] > 0x7ff)
              pix[i] = 0x7ff;
            bit += 7;
          }
      }

      if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTATOVALUE)
      {
        for (i = 0; i < 16; i++, col += 2)
        {
          const unsigned slope =
              pix[i] < 1001 ? 2
                            : curve[pix[i] << 1] - curve[(pix[i] << 1) - 2];
          const unsigned step = 1 << sh;
          RAW(row, col) =
              curve[pix[i] << 1] >
                      black + imgdata.rawparams.sony_arw2_posterization_thr
                  ? LIM(((slope * step * 1000) /
                         (curve[pix[i] << 1] - black)),
                        0, 10000)
                  : 0;
        }
      }
      else
        for (i = 0; i < 16; i++, col += 2)
          RAW(row, col) = curve[pix[i] << 1];
      col -= col & 1 ? 1 : 31;
    }
  });

  checkCancel();
  if (imgdata.rawparams.specials & LIBRAW_RAWSPECIAL_SONYARW2_DELTATOVALUE)
    maximum = 10000;
}`,
);

await replaceOnce(
  "dng.cpp",
  `void LibRaw::packed_dng_load_raw()
{
  ushort *pixel, *rp;
  unsigned row, col;

  if (tile_length < INT_MAX)
  {
      packed_tiled_dng_load_raw();
      return;
  }

  int ss = shot_select;
  shot_select = libraw_internal_data.unpacker_data.dng_frames[LIM(ss,0,(LIBRAW_IFD_MAXCOUNT*2-1))] & 0xff;

  pixel = (ushort *)calloc(raw_width, tiff_samples * sizeof *pixel);
  try
  {
    for (row = 0; row < raw_height; row++)
    {
      checkCancel();
      if (tiff_bps == 16)
        read_shorts(pixel, raw_width * tiff_samples);
      else
      {
        getbits(-1);
        for (col = 0; col < raw_width * tiff_samples; col++)
          pixel[col] = getbits(tiff_bps);
      }
      for (rp = pixel, col = 0; col < raw_width; col++)
        adobe_copy_pixel(row, col, &rp);
    }
  }
  catch (...)
  {
    free(pixel);
    shot_select = ss;
    throw;
  }
  free(pixel);
  shot_select = ss;
}`,
  `void LibRaw::packed_dng_load_raw()
{
  constexpr uint64_t max_parallel_input = 64ULL * 1024ULL * 1024ULL;
  const bool fast = raw_image && tiff_samples == 1 && tiff_bps >= 8 &&
                    tiff_bps <= 15 && tile_length == INT_MAX;
  const uint64_t row_bits_64 = static_cast<uint64_t>(raw_width) * tiff_bps;
  const uint64_t row_bytes_64 = (row_bits_64 + 7) / 8;
  const uint64_t packed_size_64 = row_bytes_64 * raw_height;

  int ss = shot_select;
  shot_select = libraw_internal_data.unpacker_data.dng_frames[LIM(ss,0,(LIBRAW_IFD_MAXCOUNT*2-1))] & 0xff;

  if (fast && packed_size_64 > 0 && packed_size_64 <= max_parallel_input)
  {
    try
    {
      const size_t row_bytes = static_cast<size_t>(row_bytes_64);
      const size_t packed_size = static_cast<size_t>(packed_size_64);
      std::vector<uchar> packed(packed_size);
      if (fread(packed.data(), 1, packed.size(), ifp) != packed.size())
        throw LIBRAW_EXCEPTION_IO_EOF;
      checkCancel();

      const unsigned sample_mask = (1U << tiff_bps) - 1;
      libraw_parallel_for(raw_height, [&](int row) {
        const uchar *source = packed.data() + static_cast<size_t>(row) * row_bytes;
        ushort *output = raw_image + static_cast<size_t>(row) * raw_width;
        unsigned accumulator = 0;
        unsigned available = 0;
        for (unsigned col = 0; col < raw_width; ++col)
        {
          while (available < tiff_bps)
          {
            accumulator = (accumulator << 8) | *source++;
            available += 8;
          }
          available -= tiff_bps;
          output[col] = curve[(accumulator >> available) & sample_mask];
        }
      });
      checkCancel();
    }
    catch (...)
    {
      shot_select = ss;
      throw;
    }
    shot_select = ss;
    return;
  }

  ushort *pixel = (ushort *)calloc(raw_width, tiff_samples * sizeof *pixel);
  try
  {
    for (unsigned row = 0; row < raw_height; row++)
    {
      checkCancel();
      if (tiff_bps == 16)
        read_shorts(pixel, raw_width * tiff_samples);
      else
      {
        getbits(-1);
        for (unsigned col = 0; col < raw_width * tiff_samples; col++)
          pixel[col] = getbits(tiff_bps);
      }
      ushort *rp = pixel;
      for (unsigned col = 0; col < raw_width; col++)
        adobe_copy_pixel(row, col, &rp);
    }
  }
  catch (...)
  {
    free(pixel);
    shot_select = ss;
    throw;
  }
  free(pixel);
  shot_select = ss;
}`,
);

await replaceOnce(
  "decoders_libraw_dcrdefs.cpp",
  `void LibRaw::packed_tiled_dng_load_raw()
{
  ushort *rp;
  unsigned row, col;

  int ss = shot_select;
  shot_select = libraw_internal_data.unpacker_data.dng_frames[LIM(ss, 0, (LIBRAW_IFD_MAXCOUNT * 2 - 1))] & 0xff;
  std::vector<ushort> pixel;

  try
  {
    int ntiles = 1 + (raw_width) / tile_width;
    if ((unsigned)ntiles * tile_width > raw_width * 2u) throw LIBRAW_EXCEPTION_ALLOC;
    pixel.resize(tile_width * ntiles * tiff_samples);
  }
  catch (...)
  {
    throw LIBRAW_EXCEPTION_ALLOC; // rethrow
  }
  try
  {
      unsigned trow = 0, tcol = 0;
      INT64 save;
      while (trow < raw_height)
      {
        checkCancel();
        save = ftell(ifp);
        if (tile_length < INT_MAX)
          fseek(ifp, get4(), SEEK_SET);

        for (row = 0; row < tile_length && (row + trow) < raw_height; row++)
        {
          if (tiff_bps == 16)
            read_shorts(pixel.data(), tile_width * tiff_samples);
          else
          {
            getbits(-1);
            for (col = 0; col < tile_width * tiff_samples; col++)
              pixel[col] = getbits(tiff_bps);
          }
          for (rp = pixel.data(), col = 0; col < tile_width; col++)
            adobe_copy_pixel(trow+row, tcol+col, &rp);
        }
        fseek(ifp, save + 4, SEEK_SET);
        if ((tcol += tile_width) >= raw_width)
          trow += tile_length + (tcol = 0);
      }
  }
  catch (...)
  {
    shot_select = ss;
    throw;
  }
  shot_select = ss;
}`,
  `void LibRaw::packed_tiled_dng_load_raw()
{
  constexpr uint64_t max_parallel_input = 64ULL * 1024ULL * 1024ULL;
  const bool fast = raw_image && tiff_samples == 1 && tiff_bps >= 8 &&
                    tiff_bps <= 15 && tile_width > 0 && tile_length > 0 &&
                    tile_length < INT_MAX;
  const unsigned tiles_across =
      fast ? (raw_width + tile_width - 1) / tile_width : 0;
  const unsigned tiles_down =
      fast ? (raw_height + tile_length - 1) / tile_length : 0;
  const uint64_t tile_count_64 =
      static_cast<uint64_t>(tiles_across) * tiles_down;
  const uint64_t row_bits_64 = static_cast<uint64_t>(tile_width) * tiff_bps;
  const uint64_t row_bytes_64 = (row_bits_64 + 7) / 8;
  uint64_t packed_size_64 = 0;
  if (fast)
  {
    for (unsigned tile_row = 0; tile_row < tiles_down; ++tile_row)
    {
      const unsigned y = tile_row * tile_length;
      packed_size_64 +=
          row_bytes_64 * MIN(tile_length, raw_height - y) * tiles_across;
    }
  }

  int ss = shot_select;
  shot_select = libraw_internal_data.unpacker_data.dng_frames[LIM(ss, 0, (LIBRAW_IFD_MAXCOUNT * 2 - 1))] & 0xff;
  if (fast && tile_count_64 > 0 && tile_count_64 <= INT_MAX &&
      packed_size_64 > 0 && packed_size_64 <= max_parallel_input)
  {
    try
    {
      const size_t tile_count = static_cast<size_t>(tile_count_64);
      const size_t row_bytes = static_cast<size_t>(row_bytes_64);
      const size_t packed_size = static_cast<size_t>(packed_size_64);
      std::vector<INT64> offsets(tile_count);
      fseek(ifp, data_offset, SEEK_SET);
      for (size_t tile = 0; tile < tile_count; ++tile)
        offsets[tile] = get4();

      std::vector<size_t> starts(tile_count + 1);
      for (size_t tile = 0; tile < tile_count; ++tile)
      {
        const unsigned tile_row = tile / tiles_across;
        const unsigned y = tile_row * tile_length;
        starts[tile + 1] =
            starts[tile] + row_bytes * MIN(tile_length, raw_height - y);
      }
      std::vector<uchar> packed(packed_size);
      for (size_t tile = 0; tile < tile_count; ++tile)
      {
        fseek(ifp, offsets[tile], SEEK_SET);
        const size_t bytes = starts[tile + 1] - starts[tile];
        if (fread(packed.data() + starts[tile], 1, bytes, ifp) != bytes)
          throw LIBRAW_EXCEPTION_IO_EOF;
      }
      checkCancel();

      const unsigned sample_mask = (1U << tiff_bps) - 1;
      libraw_parallel_for(static_cast<int>(tile_count), [&](int tile) {
        const unsigned tile_row = static_cast<unsigned>(tile) / tiles_across;
        const unsigned tile_col = static_cast<unsigned>(tile) % tiles_across;
        const unsigned y = tile_row * tile_length;
        const unsigned x = tile_col * tile_width;
        const unsigned rows = MIN(tile_length, raw_height - y);
        const unsigned columns = MIN(tile_width, raw_width - x);
        const uchar *source = packed.data() + starts[tile];
        for (unsigned row = 0; row < rows; ++row, source += row_bytes)
        {
          const uchar *input = source;
          ushort *output = raw_image + static_cast<size_t>(y + row) * raw_width + x;
          unsigned accumulator = 0;
          unsigned available = 0;
          for (unsigned col = 0; col < columns; ++col)
          {
            while (available < tiff_bps)
            {
              accumulator = (accumulator << 8) | *input++;
              available += 8;
            }
            available -= tiff_bps;
            output[col] = curve[(accumulator >> available) & sample_mask];
          }
        }
      });
      checkCancel();
    }
    catch (...)
    {
      shot_select = ss;
      throw;
    }
    shot_select = ss;
    return;
  }

  std::vector<ushort> pixel;
  try
  {
    int ntiles = 1 + raw_width / tile_width;
    if ((unsigned)ntiles * tile_width > raw_width * 2u)
      throw LIBRAW_EXCEPTION_ALLOC;
    pixel.resize(tile_width * ntiles * tiff_samples);
  }
  catch (...)
  {
    throw LIBRAW_EXCEPTION_ALLOC;
  }
  try
  {
    unsigned trow = 0, tcol = 0;
    while (trow < raw_height)
    {
      checkCancel();
      const INT64 save = ftell(ifp);
      if (tile_length < INT_MAX)
        fseek(ifp, get4(), SEEK_SET);
      for (unsigned row = 0; row < tile_length && row + trow < raw_height; row++)
      {
        if (tiff_bps == 16)
          read_shorts(pixel.data(), tile_width * tiff_samples);
        else
        {
          getbits(-1);
          for (unsigned col = 0; col < tile_width * tiff_samples; col++)
            pixel[col] = getbits(tiff_bps);
        }
        ushort *rp = pixel.data();
        for (unsigned col = 0; col < tile_width; col++)
          adobe_copy_pixel(trow + row, tcol + col, &rp);
      }
      fseek(ifp, save + 4, SEEK_SET);
      if ((tcol += tile_width) >= raw_width)
        trow += tile_length + (tcol = 0);
    }
  }
  catch (...)
  {
    shot_select = ss;
    throw;
  }
  shot_select = ss;
}`,
);

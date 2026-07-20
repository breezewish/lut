# Automatic Exposure Baseline Tests

- A uniform 2% linear source meters to 18% gray.
- A bright p99 tail limits exposed highlights to 6.0 linear.
- An all-black source returns zero EV without a non-finite gain.
- The shared color pipeline accepts the full effective exposure range produced by automatic baseline plus relative adjustment and rejects values outside it.
- A production SwiftShader browser keeps the automatic baseline out of the interface and exports the same RGB16 result as the native pipeline supplied with the reported effective EV.
- Base and LUT previews, Look thumbnails, warm photo selection, and export reuse the cached baseline without a second RAW decode or metering pass.

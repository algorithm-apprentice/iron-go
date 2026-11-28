# Smooth the application icon silhouette

Keep the existing GO artwork, metal frame and macOS canvas padding. Replace
the rough cutout and bright fringe with one centered, anti-aliased rounded
mask inset slightly into the opaque frame. Avoid rescaling the artwork or
regenerating it with a different composition. Use the
[standard icon generation steps](../BUILDING.md#app-icon).

Confirm that the mask lies inside the original opaque frame, the corners stay
transparent, and the center stays opaque. Compare the old fringe and the new
edges on light and dark backgrounds, at 1024 px and all shipped small sizes.
Follow the [bundle checks](../BUILDING.md#release-checklist) on a disposable,
read-only DMG mount and verify that `CFBundleIconFile` names the updated ICNS.

## Verification

The original alpha bounds were `(92, 92, 932, 932)`, outside the clean inset.
The new 1024 px master uses a symmetric mask with bounds `(98, 98, 926, 926)`
and a 185 px corner radius, rasterized at 8× and box-downsampled. Every
nontransparent mask pixel lies over originally opaque artwork. Light and dark
previews and small ICNS representations were checked. `npm run check` passed.
The read-only mounted DMG verified its checksum, arm64 executable, macOS 15
minimum, Applications link, updated ICNS, and ad-hoc app signature.

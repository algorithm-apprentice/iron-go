# Smooth the application icon silhouette

Keep the existing GO artwork, metal frame and macOS canvas padding. Replace
the rough cutout and bright fringe with one centered, anti-aliased rounded
mask inset slightly into the opaque frame. Avoid rescaling the artwork or
regenerating it with a different composition. Derive the welcome, favicon,
and native icon resources from the same 1024 px master.

Verify the old edge has an irregular fringe; verify the new silhouette at
1024 px and the shipped small sizes on light and dark backgrounds. Check that
corners stay transparent, the center stays opaque, and the mounted DMG
contains the updated arm64 app and Applications link. Use a disposable mount
point. The local package can be ad-hoc signed; distribution is out of scope.

Confirm that the mask lies entirely inside the original opaque frame and
compare its four corners and straight edges on light and dark backgrounds.
Inspect the 64 px and 128 px derivatives and small native sizes. Verify that
the mounted app's `CFBundleIconFile` names the regenerated ICNS resource.

## Verification

The original alpha bounds were `(92, 92, 932, 932)`, outside the clean inset.
The new 1024 px master uses a symmetric mask with bounds `(98, 98, 926, 926)`
and a 185 px corner radius, rasterized at 8× and box-downsampled. Every
nontransparent mask pixel lies over originally opaque artwork. Light and dark
previews and small ICNS representations were checked. `npm run check` passed.
The read-only mounted DMG verified its checksum, arm64 executable, macOS 15
minimum, Applications link, updated ICNS, and ad-hoc app signature.

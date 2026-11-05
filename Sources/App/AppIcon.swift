import AppKit
import notify

/// The app icon: what ships in the bundle, and what macOS draws for it. Amber in the middle means the
/// anvil; the blank generic app icon is white and pale blue there.
///
/// Finder asks macOS for an app's icon by its path. Stage Manager and the Dock ask by bundle id, and macOS 26
/// keeps the picture it made for a bundle id even after the app changes: a reinstall, a new version, a new
/// icon file or an asset catalog don't replace it. A Mac that ever registered a Forge build without an icon
/// (the first builds had none) kept handing Stage Manager the blank white tile for `ai.forjado.forge`.
/// `healIfStale` notices that and asks macOS to clear its icon cache, which it then redraws.
@MainActor
enum AppIcon {
    /// Pixel sizes AppIcon.icns holds: 32 pt @2x up to 512 pt @2x. The 16 and 32 px art is drawn bigger than
    /// macOS 26's icon grid, so macOS puts it on a light plate; without it macOS scales the 64 px picture down.
    static let sizes = [64, 128, 256, 512, 1024]
    /// Sizes macOS draws in small places: Stage Manager's strip, Finder lists, menus, the Dock.
    static let drawnSizes = [16, 32, 48, 64, 128, 256]

    static func checks(_ check: (String, Bool) -> Void) {
        check("the anvil app icon ships inside the app", shipsTheAnvil)
        check("the app icon holds every size from 64 to 1024 px", hasEverySize)
        check("Finder shows the anvil at every size, never on a plate or a blank tile", finderShowsTheAnvil)
        switch SystemIcon.healIfStale(bundleID: Bundle.main.bundleIdentifier ?? "", waitForRedraw: true) {
        case .unavailable:
            print("- Stage Manager's icon not checked: this macOS doesn't say what it draws")
        case let state:
            check("Stage Manager and the Dock show the anvil (macOS's icon for the bundle id), light and dark", state != .stale)
        }
    }

    static var icns: URL? {
        guard Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String == "AppIcon" else { return nil }
        return Bundle.main.url(forResource: "AppIcon", withExtension: "icns")
    }

    /// The bundle names AppIcon.icns, and that file is the anvil.
    static var shipsTheAnvil: Bool {
        guard let url = icns, let icon = NSImage(contentsOf: url) else { return false }
        return isTheAnvil(icon, size: 64)
    }

    static var pixelSizes: Set<Int> {
        guard let url = icns, let icon = NSImage(contentsOf: url) else { return [] }
        return Set(icon.representations.map(\.pixelsWide))
    }

    static var hasEverySize: Bool { Set(sizes).isSubset(of: pixelSizes) }

    /// What Finder draws for the app (the About box uses the same icon). A bundle built a moment ago can
    /// still get the blank icon for a second while macOS registers it, so this asks a few times before failing.
    static var finderShowsTheAnvil: Bool {
        LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
        for attempt in 0..<10 {
            if attempt > 0 { Thread.sleep(forTimeInterval: 0.5) }
            let icon = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
            if drawnSizes.allSatisfy({ isTheAnvil(icon, size: $0) }) { return true }
        }
        return false
    }

    static func isTheAnvil(_ icon: NSImage, size: Int) -> Bool {
        guard
            let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return false }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
        NSGraphicsContext.restoreGraphicsState()
        return SystemIcon.looksLikeTheAnvil(rep)
    }
}

/// macOS's own picture of an app's icon, asked for by bundle id the way Stage Manager and the Dock ask
/// (IconServices). It's a private part of macOS, looked up at run time: on a macOS without it everything
/// here answers `.unavailable` and does nothing.
enum SystemIcon {
    enum State { case anvil, stale, unavailable }

    /// Points Stage Manager's strip, the Dock and app switchers ask for; each at 1x and 2x, light and dark.
    static let points: [CGFloat] = [16, 32, 64, 128, 256]

    /// The system's notification that makes macOS clear its icon cache (it ignores repeats within a minute).
    static let clearCacheNotification = "com.apple.iconservicesd.clearCache.immediately"

    /// Checks what macOS draws for `bundleID`; when that isn't the anvil, asks macOS to clear its icon cache.
    /// With `waitForRedraw`, waits up to 15 s for the anvil and answers what macOS draws after the clear.
    @discardableResult
    static func healIfStale(bundleID: String, waitForRedraw: Bool) -> State {
        let before = state(bundleID: bundleID)
        guard before == .stale else { return before }
        notify_post(clearCacheNotification)
        guard waitForRedraw else { return .stale }
        for _ in 0..<15 {
            Thread.sleep(forTimeInterval: 1)
            if state(bundleID: bundleID) == .anvil { return .anvil }
        }
        return .stale
    }

    static func state(bundleID: String) -> State {
        var sawAny = false
        for point in points {
            for scale: CGFloat in [1, 2] {
                for dark in [false, true] {
                    guard let image = image(bundleID: bundleID, points: point, scale: scale, dark: dark) else { continue }
                    sawAny = true
                    if !looksLikeTheAnvil(NSBitmapImageRep(cgImage: image)) { return .stale }
                }
            }
        }
        return sawAny ? .anvil : .unavailable
    }

    /// Amber in the middle, and the dark tile (not a white plate) between the anvil and the left edge.
    static func looksLikeTheAnvil(_ rep: NSBitmapImageRep) -> Bool {
        let size = rep.pixelsWide
        guard size > 0, let mid = rep.colorAt(x: size / 2, y: size * 47 / 100)?.usingColorSpace(.deviceRGB),
            let edge = rep.colorAt(x: (size * 15 + 50) / 100, y: size / 2)?.usingColorSpace(.deviceRGB)
        else { return false }
        let amber = mid.redComponent > 0.6 && mid.redComponent > mid.greenComponent && mid.greenComponent > mid.blueComponent + 0.15
        let darkTile = edge.alphaComponent > 0.9 && edge.redComponent < 0.35 && edge.greenComponent < 0.35
        return amber && darkTile
    }

    // MARK: IconServices, looked up at run time

    private typealias Alloc = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>
    private typealias InitWithID = @convention(c) (AnyObject, Selector, NSString) -> Unmanaged<AnyObject>?
    private typealias InitWithSize = @convention(c) (AnyObject, Selector, CGSize, CGFloat) -> Unmanaged<AnyObject>?
    private typealias SetInt = @convention(c) (AnyObject, Selector, Int) -> Void
    private typealias Fetch = @convention(c) (AnyObject, Selector, AnyObject, AnyObject) -> Void

    private static let loaded = dlopen("/System/Library/PrivateFrameworks/IconServices.framework/IconServices", RTLD_NOW) != nil

    private static func make(_ className: String, _ initName: String) -> (AnyClass, Selector, IMP)? {
        guard loaded, let cls = NSClassFromString(className), let m = class_getInstanceMethod(cls, NSSelectorFromString(initName))
        else { return nil }
        return (cls, NSSelectorFromString(initName), method_getImplementation(m))
    }

    private static func alloc(_ cls: AnyClass) -> AnyObject? {
        guard let m = class_getClassMethod(cls, NSSelectorFromString("alloc")) else { return nil }
        return unsafeBitCast(method_getImplementation(m), to: Alloc.self)(cls, NSSelectorFromString("alloc")).takeUnretainedValue()
    }

    /// The picture macOS hands out for `bundleID` at `points` (nil when macOS can't say).
    static func image(bundleID: String, points: CGFloat, scale: CGFloat, dark: Bool) -> CGImage? {
        guard let (iconClass, initID, initIDImp) = make("ISBundleIdentifierIcon", "initWithBundleIdentifier:"),
            let (descClass, initSize, initSizeImp) = make("ISImageDescriptor", "initWithSize:scale:"),
            let iconMem = alloc(iconClass), let descMem = alloc(descClass),
            let icon = unsafeBitCast(initIDImp, to: InitWithID.self)(iconMem, initID, bundleID as NSString)?.takeRetainedValue(),
            let desc = unsafeBitCast(initSizeImp, to: InitWithSize.self)(descMem, initSize, CGSize(width: points, height: points), scale)?
                .takeRetainedValue(),
            let setAppearance = class_getInstanceMethod(descClass, NSSelectorFromString("setAppearance:")),
            let fetch = class_getInstanceMethod(iconClass, NSSelectorFromString("getCGImageForImageDescriptor:completion:"))
        else { return nil }
        unsafeBitCast(method_getImplementation(setAppearance), to: SetInt.self)(desc, NSSelectorFromString("setAppearance:"), dark ? 1 : 0)
        let done = DispatchSemaphore(value: 0)
        let box = ImageBox()
        let completion: @convention(block) (CGImage?) -> Void = { image in
            box.image = image
            done.signal()
        }
        unsafeBitCast(method_getImplementation(fetch), to: Fetch.self)(
            icon, NSSelectorFromString("getCGImageForImageDescriptor:completion:"), desc, unsafeBitCast(completion, to: AnyObject.self))
        guard done.wait(timeout: .now() + 10) == .success else { return nil }
        return box.image
    }

    private final class ImageBox: @unchecked Sendable { var image: CGImage? }
}

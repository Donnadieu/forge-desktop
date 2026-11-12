import Foundation

/// What a key press sends to a shell.
enum TerminalKeys {
    /// macOS key codes for the keys that aren't plain characters.
    static func bytes(chars: String, key: UInt16, control: Bool, appCursor: Bool = false) -> [UInt8] {
        let arrow = appCursor ? "\u{1B}O" : "\u{1B}["
        switch key {
        case 36, 76: return [13]
        case 51: return [127]
        case 48: return [9]
        case 53: return [27]
        case 123: return Array((arrow + "D").utf8)
        case 124: return Array((arrow + "C").utf8)
        case 125: return Array((arrow + "B").utf8)
        case 126: return Array((arrow + "A").utf8)
        case 115: return Array("\u{1B}[H".utf8)
        case 119: return Array("\u{1B}[F".utf8)
        case 116: return Array("\u{1B}[5~".utf8)
        case 121: return Array("\u{1B}[6~".utf8)
        case 117: return Array("\u{1B}[3~".utf8)
        default: break
        }
        if control, let c = chars.lowercased().unicodeScalars.first, c.isASCII {
            let v = UInt8(c.value)
            if (0x61...0x7A).contains(v) { return [v & 0x1F] }
            if v == 0x5B { return [27] }
            if v == 0x5C { return [28] }
            if v == 0x5D { return [29] }
            if v == 0x20 || v == 0x40 { return [0] }
        }
        return Array(chars.utf8)
    }
}

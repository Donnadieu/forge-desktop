import AppKit
import SwiftUI

/// A long paste (over `Composer.longPaste` characters) waiting in the message box as a .txt attachment. The host
/// keeps it as a file beside the chat and the agent gets its whole text with the message (engine attachments.ts).
struct PastedText: Equatable, Identifiable {
    var id = UUID()
    var name = "Pasted text.txt"
    var text: String

    var body: [String: String] { ["name": name, "text": text] }
}

enum PastedTextChip {
    /// "Pasted text · 5,214 characters".
    static func words(_ p: PastedText) -> String { words(name: p.name, count: p.text.count) }

    static func words(name: String, count: Int) -> String {
        let n = NumberFormatter.localizedString(from: NSNumber(value: count), number: .decimal)
        return "\(name.replacingOccurrences(of: ".txt", with: "")) · \(n) characters"
    }
}

/// One chip: a text-file mark, what it is, and (in the box) a remove button.
struct TextChip: View {
    let words: String
    var remove: (() -> Void)?
    var open: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.plaintext").font(Theme.icon(.glyph)).foregroundStyle(Theme.textSec)
            Text(words).font(Theme.sans(.chatCaption, .medium)).foregroundStyle(Theme.text).lineLimit(1)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark").font(Theme.icon(.glyphXS, .semibold)).foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain).help("Remove")
            }
        }
        .padding(.horizontal, 9).frame(height: 26)
        .background(RoundedRectangle(cornerRadius: Theme.rMd).fill(Theme.wash1))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
        .contentShape(Rectangle())
        .onTapGesture { open?() }
    }
}

/// The long pastes waiting in the message box.
struct PendingTexts: View {
    let texts: [PastedText]
    let remove: (PastedText) -> Void

    var body: some View {
        HStack(spacing: 8) {
            ForEach(texts) { t in TextChip(words: PastedTextChip.words(t), remove: { remove(t) }) }
        }
    }
}

/// The text files a sent message carried (`[text: <path>]` lines), as chips; a click opens the file in Forge's viewer.
struct SentTexts: View {
    let paths: [String]
    var open: ((String) -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            ForEach(paths, id: \.self) { p in
                let count = (try? String(contentsOfFile: p, encoding: .utf8))?.count ?? 0
                TextChip(words: PastedTextChip.words(name: "Pasted text", count: count), open: { open?(p) })
                    .help("Open the pasted text")
            }
        }
    }
}

extension SessionsModel {
    /// A long paste joins the chat's message box as a .txt attachment.
    func attachText(_ text: String, to chat: Sessions.Chat) {
        let n = (texts[chat.id] ?? []).count
        texts[chat.id, default: []].append(PastedText(name: n == 0 ? "Pasted text.txt" : "Pasted text \(n + 1).txt", text: text))
    }
}

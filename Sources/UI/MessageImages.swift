import AppKit
import SwiftUI

/// A picture waiting in the message box (pasted, dropped or attached), sent with the next message.
struct PastedImage: Identifiable, Equatable {
    let id = UUID()
    let data: Data
    let mediaType: String
    let thumb: NSImage

    static func == (a: PastedImage, b: PastedImage) -> Bool { a.id == b.id }

    /// PNG or JPEG data as is; anything else macOS can read becomes a PNG.
    init?(data: Data, type: String? = nil) {
        guard let image = NSImage(data: data) else { return nil }
        if type == "image/png" || type == "image/jpeg" {
            (self.data, self.mediaType) = (data, type ?? "image/png")
        } else {
            guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:])
            else { return nil }
            (self.data, self.mediaType) = (png, "image/png")
        }
        thumb = image
    }

    var body: [String: String] { ["mediaType": mediaType, "data": data.base64EncodedString()] }
}

enum MessageImages {
    /// Claude's limit per picture.
    static let maxBytes = 5 * 1024 * 1024

    /// The pictures on the clipboard (copied images or image files); empty when it holds none.
    static func fromPasteboard(_ pb: NSPasteboard = .general) -> [PastedImage] {
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            let images = fromFiles(urls)
            if !images.isEmpty { return images }
        }
        if let png = pb.data(forType: .png) { return [PastedImage(data: png, type: "image/png")].compactMap { $0 } }
        if let tiff = pb.data(forType: .tiff) { return [PastedImage(data: tiff)].compactMap { $0 } }
        return []
    }

    static func fromFiles(_ urls: [URL]) -> [PastedImage] {
        urls.compactMap { url in
            let ext = url.pathExtension.lowercased()
            guard ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff"].contains(ext), let data = try? Data(contentsOf: url) else { return nil }
            return PastedImage(data: data, type: ext == "png" ? "image/png" : (ext == "jpg" || ext == "jpeg") ? "image/jpeg" : nil)
        }
        .filter { $0.data.count <= maxBytes }
    }

    /// A message's words and the pictures it carries (`[image: <path>]` lines, engine sessions/attachments.ts).
    static func split(_ text: String) -> (words: String, paths: [String]) {
        guard text.contains("[image: ") else { return (text, []) }
        var words: [Substring] = []
        var paths: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("[image: "), t.hasSuffix("]") {
                paths.append(String(t.dropFirst(8).dropLast()))
            } else {
                words.append(line)
            }
        }
        return (words.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), paths)
    }
}

/// The pictures a sent message carried, small.
struct ImageStrip: View {
    let paths: [String]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(paths, id: \.self) { p in
                Group {
                    if let img = NSImage(contentsOfFile: p) {
                        Image(nsImage: img).resizable().scaledToFill()
                    } else {
                        Image(systemName: "photo").foregroundStyle(Theme.textMuted)
                    }
                }
                .frame(width: 72, height: 54).clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
                .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
                .onTapGesture { NSWorkspace.shared.open(URL(fileURLWithPath: p)) }
                .help("Open the picture")
            }
        }
    }
}

/// The pictures waiting in the message box, each with its own remove button.
struct PendingImages: View {
    let images: [PastedImage]
    let remove: (PastedImage) -> Void

    var body: some View {
        HStack(spacing: 8) {
            ForEach(images) { img in
                Image(nsImage: img.thumb).resizable().scaledToFill()
                    .frame(width: 56, height: 42).clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
                    .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.border))
                    .overlay(alignment: .topTrailing) {
                        Button {
                            remove(img)
                        } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundStyle(Theme.text, Theme.bg)
                        }
                        .buttonStyle(.plain).offset(x: 5, y: -5).help("Remove")
                    }
            }
        }
    }
}

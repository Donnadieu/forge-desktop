import SwiftUI

/// Code coloured by its language, for chat code blocks and the diff: keywords, types, strings, numbers and comments.
/// A small scanner, not a parser: it works line by line (a diff shows lines out of context) and never changes the text.
enum Syntax {
    enum Kind { case plain, keyword, type, string, number, comment }

    struct Token: Equatable {
        let kind: Kind
        let text: String
        init(_ kind: Kind, _ text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// The language a file's name says (`orders/total.py` is python), or nil.
    static func language(path: String) -> String? {
        let name = (path as NSString).lastPathComponent.lowercased()
        if ["gemfile", "rakefile", "podfile", "fastfile"].contains(name) { return "ruby" }
        if name == "makefile" || name == "dockerfile" { return "sh" }
        let ext = (name as NSString).pathExtension
        return ext.isEmpty ? nil : family(ext)
    }

    /// Fence names and file extensions to one family; nil when there's nothing to colour.
    static func family(_ name: String?) -> String? {
        switch (name ?? "").lowercased() {
        case "swift": return "swift"
        case "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "javascript", "typescript", "json", "jsonc": return "js"
        case "py", "python": return "python"
        case "rb", "ruby", "erb", "rake", "gemspec": return "ruby"
        case "go", "golang": return "go"
        case "rs", "rust": return "rust"
        case "sh", "bash", "zsh", "shell", "console", "fish", "env": return "sh"
        case "yml", "yaml", "toml": return "yaml"
        case "css", "scss", "less": return "css"
        case "sql": return "sql"
        case "java", "kt", "kts", "kotlin", "scala", "cs", "csharp": return "java"
        case "c", "h", "cc", "cpp", "hpp", "m", "mm", "objc": return "c"
        case "php": return "php"
        default: return nil
        }
    }

    private static let keywords: [String: Set<String>] = [
        "swift": [
            "let", "var", "func", "if", "else", "guard", "return", "struct", "class", "enum", "case", "switch", "default", "for", "in",
            "while", "import", "static", "private", "fileprivate", "public", "internal", "extension", "protocol", "init", "self", "Self",
            "nil", "true", "false", "try", "await", "async", "throws", "throw", "do", "catch", "some", "any", "where", "break", "continue",
            "defer", "inout", "mutating", "override", "final", "weak", "lazy", "typealias", "as", "is",
        ],
        "js": [
            "const", "let", "var", "function", "return", "if", "else", "for", "while", "of", "in", "import", "export", "from", "default",
            "class", "extends", "new", "this", "null", "undefined", "true", "false", "async", "await", "try", "catch", "finally", "throw",
            "typeof", "instanceof", "interface", "type", "enum", "switch", "case", "break", "continue", "readonly", "private", "public",
            "static", "as", "void", "yield",
        ],
        "python": [
            "def", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "import", "from", "as", "class", "None",
            "True", "False", "try", "except", "finally", "raise", "with", "lambda", "yield", "pass", "break", "continue", "async",
            "await", "is", "global", "self",
        ],
        "ruby": [
            "def", "end", "if", "elsif", "else", "unless", "while", "until", "do", "return", "class", "module", "require", "self", "nil",
            "true", "false", "and", "or", "not", "then", "begin", "rescue", "ensure", "yield", "case", "when", "attr_reader",
            "attr_accessor", "private", "include", "extend", "raise", "new",
        ],
        "go": [
            "func", "package", "import", "return", "if", "else", "for", "range", "var", "const", "type", "struct", "interface", "map",
            "chan", "go", "defer", "select", "switch", "case", "default", "nil", "true", "false", "break", "continue",
        ],
        "rust": [
            "fn", "let", "mut", "pub", "use", "mod", "struct", "enum", "impl", "trait", "for", "in", "if", "else", "match", "return",
            "loop", "while", "self", "Self", "true", "false", "as", "where", "async", "await", "move", "crate", "const", "static",
        ],
        "sh": [
            "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return", "export",
            "local", "set", "echo", "exit", "cd", "source",
        ],
        "yaml": ["true", "false", "null", "yes", "no", "on", "off"],
        "css": ["import", "media", "important"],
        "sql": [
            "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "add", "drop",
            "join", "left", "right", "inner", "on", "and", "or", "not", "null", "as", "order", "by", "group", "limit", "index",
        ],
        "java": [
            "public", "private", "protected", "class", "interface", "static", "final", "void", "return", "if", "else", "for", "while",
            "new", "this", "null", "true", "false", "import", "package", "extends", "implements", "try", "catch", "throw", "fun", "val",
            "var", "override", "when", "is", "in",
        ],
        "c": [
            "int", "char", "void", "return", "if", "else", "for", "while", "struct", "typedef", "static", "const", "unsigned", "long",
            "include", "define", "NULL", "nil", "YES", "NO", "self", "auto", "class", "namespace", "template", "bool", "true", "false",
        ],
        "php": ["function", "return", "if", "else", "foreach", "as", "echo", "class", "public", "private", "new", "null", "true", "false"],
    ]

    private static func lineComment(_ lang: String) -> [String] {
        switch lang {
        case "python", "ruby", "sh", "yaml": return ["#"]
        case "sql": return ["--"]
        case "css": return []
        case "php": return ["//", "#"]
        default: return ["//"]
        }
    }

    /// The text cut into coloured runs; joined back, it's exactly the text given.
    static func tokens(_ text: String, language: String?) -> [Token] {
        guard let lang = family(language) else { return [Token(.plain, text)] }
        let words = keywords[lang] ?? []
        let comments = lineComment(lang)
        let chars = Array(text)
        var out: [Token] = []
        var plain = ""
        func emit(_ kind: Kind, _ s: String) {
            if !plain.isEmpty {
                out.append(Token(.plain, plain))
                plain = ""
            }
            out.append(Token(kind, s))
        }
        var i = 0
        func starts(_ s: String) -> Bool {
            let a = Array(s)
            return i + a.count <= chars.count && Array(chars[i..<(i + a.count)]) == a
        }
        while i < chars.count {
            let c = chars[i]
            if let mark = comments.first(where: starts), lang != "sh" || i == 0 || chars[i - 1] == " " || chars[i - 1] == "\t" {
                _ = mark
                let stop = (i..<chars.count).first { chars[$0] == "\n" } ?? chars.count
                emit(.comment, String(chars[i..<stop]))
                i = stop
                continue
            }
            if starts("/*") {
                let end = (i + 2..<max(i + 2, chars.count)).first { j in j + 1 < chars.count && chars[j] == "*" && chars[j + 1] == "/" }
                let stop = end.map { $0 + 2 } ?? chars.count
                emit(.comment, String(chars[i..<stop]))
                i = stop
                continue
            }
            if c == "\"" || c == "'" || (c == "`" && lang != "sh") {
                if c == "'", lang == "rust" || lang == "swift", i > 0, chars[i - 1].isLetter {
                    plain.append(c)
                    i += 1
                    continue
                }
                // A quoted string ends at its line (a missing quote never colours the rest); a backtick one may run on.
                var j = i + 1
                while j < chars.count, chars[j] != c, c == "`" || chars[j] != "\n" {
                    j += chars[j] == "\\" ? 2 : 1
                }
                let stop = min(j + 1, chars.count)
                emit(.string, String(chars[i..<stop]))
                i = stop
                continue
            }
            if c.isNumber, i == 0 || !(chars[i - 1].isLetter || chars[i - 1] == "_" || chars[i - 1].isNumber) {
                var j = i
                while j < chars.count, chars[j].isNumber || chars[j] == "." || chars[j] == "_" || chars[j] == "x" || chars[j].isHexDigit {
                    j += 1
                }
                emit(.number, String(chars[i..<j]))
                i = j
                continue
            }
            if c.isLetter || c == "_" || c == "@" || c == "$" {
                var j = i + 1
                while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" {
                    j += 1
                }
                let word = String(chars[i..<j])
                let bare = word.trimmingCharacters(in: CharacterSet(charactersIn: "@$"))
                if words.contains(lang == "sql" ? bare.lowercased() : bare) {
                    emit(.keyword, word)
                } else if lang != "sh", lang != "yaml", let f = bare.first, f.isUppercase, bare.count > 1 {
                    emit(.type, word)
                } else {
                    plain += word
                }
                i = j
                continue
            }
            plain.append(c)
            i += 1
        }
        if !plain.isEmpty { out.append(Token(.plain, plain)) }
        return out
    }

    static func color(_ kind: Kind) -> Color {
        switch kind {
        case .plain: return Theme.silver
        case .keyword: return Theme.codeKeyword
        case .type: return Theme.codeType
        case .string: return Theme.codeString
        case .number: return Theme.codeNumber
        case .comment: return Theme.textMuted
        }
    }

    /// The coloured text, kept per text and language so a long diff isn't scanned again while it scrolls.
    @MainActor static func attributed(_ text: String, language: String?) -> AttributedString {
        let key = "\(language ?? "")\u{0}\(text)".hashValue
        if let hit = cache[key] { return hit }
        var a = AttributedString()
        for t in tokens(text, language: language) {
            var run = AttributedString(t.text)
            run.foregroundColor = color(t.kind)
            a += run
        }
        if cache.count > 20_000 { cache.removeAll() }
        cache[key] = a
        return a
    }

    @MainActor private static var cache: [Int: AttributedString] = [:]
}

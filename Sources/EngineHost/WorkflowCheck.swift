import Foundation

/// Checks a hand-edited workflow file with the engine's own rules (engine `check-workflow.js`), plus the one
/// rule only the app knows: settings Workflow Studio or Settings own are changed there, not in the file.
enum WorkflowCheck {
    struct Problem: Decodable, Equatable, Sendable {
        var line: Int
        var message: String
    }

    /// The engine's problems with `text`; one plain problem when the engine couldn't run.
    static func engine(_ text: String) async -> [Problem] {
        guard let (node, script) = try? EngineHost.locate() else {
            return [Problem(line: 1, message: "Forge couldn't find its engine to check the file. Nothing was saved.")]
        }
        let checker = URL(fileURLWithPath: script).deletingLastPathComponent().appendingPathComponent("check-workflow.js").path
        return await Task.detached { () -> [Problem] in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [checker]
            let input = Pipe()
            let output = Pipe()
            p.standardInput = input
            p.standardOutput = output
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { return [Problem(line: 1, message: "Forge couldn't run the check. Nothing was saved.")] }
            input.fileHandleForWriting.write(Data(text.utf8))
            try? input.fileHandleForWriting.close()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            struct Answer: Decodable { var problems: [Problem] }
            guard let answer = try? JSONDecoder().decode(Answer.self, from: data) else {
                return [Problem(line: 1, message: "Forge couldn't read the check's answer. Nothing was saved.")]
            }
            return answer.problems
        }.value
    }

    /// Hand edits to settings the app owns: the next save from the app would replace them.
    static func owned(_ text: String, app: String) -> [Problem] {
        WorkflowFile.ownedChanges(edited: text, app: app).map { change in
            if change.key == "the app's part" {
                return Problem(line: change.line, message: "This part is written by the app (the board's notes, stages that are off). Edit below it.")
            }
            let name = change.key.components(separatedBy: ".").last ?? change.key
            let place = WorkflowFile.studioKeys.contains(change.key) ? "Workflow Studio" : "Settings"
            return Problem(line: change.line, message: "\(name) is set in \(place). Change it there; an edit here would be replaced.")
        }
    }

    /// Everything wrong with `text`, by line; empty = it can be saved.
    static func all(_ text: String, app: String?) async -> [Problem] {
        let found = await engine(text)
        guard found.isEmpty, let app else { return found }
        return owned(text, app: app)
    }
}

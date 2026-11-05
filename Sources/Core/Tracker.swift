import Foundation

/// Where the cards live: Linear or Basecamp. `SetupChoices.tracker` is nil for settings saved before
/// Basecamp came, which means Linear.
enum Tracker: String, Codable, CaseIterable, Sendable {
    case linear, basecamp

    /// The name people know it by.
    var name: String {
        switch self {
        case .linear: return "Linear"
        case .basecamp: return "Basecamp"
        }
    }
}

/// The Basecamp board setup picked: the account, who Forge acts as, the project and its card table,
/// and which Card Table column is each pipeline column. Never a secret: the sign-in is in the Keychain.
struct BasecampBoard: Codable, Equatable, Sendable {
    var accountID: String
    var accountName: String?
    /// The signed-in person's Basecamp id: Forge assigns the cards it takes to them.
    var personID: String
    var personName: String
    var projectID: String?
    var projectName: String?
    var cardTableID: String?
    /// Pipeline column name -> Card Table column id.
    var columns: [String: String]?

    /// The card table's page in Basecamp.
    var url: String {
        guard let p = projectID, let t = cardTableID else { return "https://3.basecamp.com/\(accountID)" }
        return "https://3.basecamp.com/\(accountID)/buckets/\(p)/card_tables/\(t)"
    }
}

extension SetupChoices {
    /// The board's tracker (Linear for settings saved before Basecamp came).
    var board: Tracker { tracker ?? .linear }

    /// Who is signed in to the board's tracker; nil until the first setup screen is done.
    var trackerUser: String? {
        switch board {
        case .linear: return linearUser
        case .basecamp: return basecamp?.personName
        }
    }

    /// The workspace or account name under the signed-in person.
    var trackerOrg: String? {
        switch board {
        case .linear: return linearOrg
        case .basecamp: return basecamp?.accountName
        }
    }
}

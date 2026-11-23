import Foundation

extension Checks {
    /// GitHub's answers to the project list, as GitHub sends them (recorded Nov 22 2026), and what the project step
    /// shows for each. A person with no project, or one in an organization that keeps its projects from Forge's
    /// sign-in, used to see only "Choose…" and a grey Continue, with nothing saying why.
    static func githubProjectListChecks(_ check: (String, Bool) -> Void) {
        func json(_ s: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:] }
        let project = #"{"id":"PVT_1","number":1,"title":"Website","url":"https://github.com/users/marin/projects/1","closed":false}"#
        let orgProject = #"{"id":"PVT_2","number":4,"title":"Roadmap","url":"https://github.com/orgs/acme/projects/4","closed":false}"#
        let closed = #"{"id":"PVT_3","number":2,"title":"Old","url":"https://github.com/users/marin/projects/2","closed":true}"#

        // No projects anywhere: GitHub answers with empty lists and no error.
        let none = try? GitHubProjectsAPI.projectList(json(#"{"data":{"viewer":{"projectsV2":{"nodes":[]},"organizations":{"nodes":[]}}}}"#))
        check("an account with no projects reads as an empty list", none?.projects.isEmpty == true && none?.hidden.isEmpty == true)
        check(
            "no projects shows the empty state, not a bare picker",
            GitHubProjectScreen.listState(loaded: true, count: 0, problem: nil, reconnect: false) == .empty)
        check(
            "the empty state links to the person's projects on GitHub",
            GitHubProjectScreen.newProjectURL(login: "marin") == "https://github.com/marin?tab=projects")

        // The person's own projects and their organizations' projects are both listed; closed ones aren't.
        let both = try? GitHubProjectsAPI.projectList(
            json(
                #"{"data":{"viewer":{"projectsV2":{"nodes":[\#(project),\#(closed)]},"#
                    + #""organizations":{"nodes":[{"login":"acme","projectsV2":{"nodes":[\#(orgProject)]}}]}}}}"#))
        check("own and organization projects are listed, closed ones left out", both?.projects.map(\.id) == ["PVT_1", "PVT_2"])
        check("a list with projects shows the picker", GitHubProjectScreen.listState(loaded: true, count: 2, problem: nil, reconnect: false) == .pick)

        // An organization with OAuth app access restrictions (or SAML): GitHub sends the rest and an error for that org.
        let restricted = json(
            #"{"data":{"viewer":{"projectsV2":{"nodes":[\#(project)]},"organizations":{"nodes":[{"login":"acme","projectsV2":null}]}}},"#
                + #""errors":[{"type":"FORBIDDEN","path":["viewer","organizations","nodes",0,"projectsV2"],"#
                + #""message":"Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited."}]}"#
        )
        let partial = try? GitHubProjectsAPI.projectList(restricted)
        check("an organization GitHub keeps closed doesn't hide the person's own projects", partial?.projects.map(\.id) == ["PVT_1"])
        check("it names the organization it couldn't read", partial?.hidden == ["acme"])
        check(
            "and says how to open it up",
            GitHubProjectScreen.hiddenLine(["acme"]).contains("acme") && GitHubProjectScreen.hiddenLine(["acme"]).contains("GitHub CLI"))

        // A sign-in without the project scope: say so, and offer to reconnect.
        let scopes = json(
            #"{"errors":[{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes."}]}"#
        )
        var scopeFailure: GitHubProjectsAPI.Failure?
        do { _ = try GitHubProjectsAPI.projectList(scopes) } catch { scopeFailure = error as? GitHubProjectsAPI.Failure }
        check("a sign-in without project access is a sign-in problem", scopeFailure?.signedOut == true)
        check(
            "missing project access offers the reconnect",
            GitHubProjectScreen.listState(loaded: true, count: 0, problem: scopeFailure?.description, reconnect: scopeFailure?.signedOut == true)
                == .reconnect(GitHubProjectsAPI.missingProjectAccess))
        check("the reconnect button says what it does", GitHubProjectScreen.reconnectTitle == "Reconnect GitHub with project access")

        // Any other failure shows GitHub's own words.
        var other: Error?
        do {
            _ = try GitHubProjectsAPI.projectList(
                json(#"{"errors":[{"type":"SERVICE_UNAVAILABLE","path":["viewer","projectsV2"],"message":"Something went wrong"}]}"#))
        } catch { other = error }
        check("another failure keeps GitHub's words", "\(other.map { "\($0)" } ?? "")" == "GitHub said: Something went wrong")
        check(
            "a failed load shows the problem instead of an empty picker",
            GitHubProjectScreen.listState(loaded: true, count: 0, problem: "GitHub said: Something went wrong", reconnect: false)
                == .failed("GitHub said: Something went wrong"))
        check(
            "nothing is shown as empty while the list is loading",
            GitHubProjectScreen.listState(loaded: false, count: 0, problem: nil, reconnect: false) == .loading)
    }
}

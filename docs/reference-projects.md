# Reference: "Projects" and new-thread lifecycle in `openai/codex`

Research note for the `codex-remote` browser client. Everything below is quoted from the
public Rust sources of `openai/codex`.

**Ref used:** `rust-v0.165.0` (the newest tag the reachable mirrors served reliably;
`rust-v0.166.0` returned 403/404 on jsDelivr, statically.io and raw.githack). The findings were
**cross-checked against `@main`**: `codex-rs/app-server-protocol/src/protocol/v2/project.rs` is
byte-identical (SHA-256 equal, 6087 B) at both refs, and `@main`'s
`protocol/common.rs` declares the same 7 `project/*` methods (at lines 801-843 vs 797-837 here).
Line numbers below are from `rust-v0.165.0`. Do **not** trust the jsDelivr *directory listing*
(`data.jsdelivr.com/...?structure=flat`) — the `@main` listing is truncated to ~2.6k files and
silently omits the whole generated `schema/typescript/v2/` project surface, which looks like a
version difference but is not. Files were fetched via
`https://cdn.jsdelivr.net/gh/openai/codex@rust-v0.165.0/<path>` and
`https://raw.githack.com/openai/codex/rust-v0.165.0/<path>`.
**`github.com` was not used.** Local generated bindings under `codex-remote/protocol/` were
compared against the published `codex-rs/app-server-protocol/schema/typescript/v2/` at that
tag to date them.

**Local bindings version:** `codex-remote/protocol/v2/Project.ts` is byte-identical in size
(500 B) to the published one at `rust-v0.158.0` … `rust-v0.165.0`, so our bindings are from
that range. The reasons our bindings look "incomplete" are explained in §2.4 — they are not
a server limitation.

---

## 0. TL;DR (the six things that matter)

1. A **project is a real, durable, first-class object** in the app-server: 7 request methods
   (`project/list|read|create|import|update|move|delete`) + 2 notifications
   (`project/changed`, `thread/project/updated`). It lives in the **SQLite thread store**, not
   in `config.toml`.
2. **`project/list` exists.** Our bindings lack it only because it is marked *experimental*
   and `codex app-server generate-ts` strips experimental methods by default.
3. **A thread's project is never derived from `cwd`.** It comes from
   `thread/start.projectId`, `thread/metadata/update.projectId`, or fork inheritance. `cwd`
   and `projectId` are independent axes.
4. `[projects.'C:\...']` in `config.toml` is **only a trust level** (`ProjectConfig` has
   exactly one field) and `[desktop]` is parsed as an **opaque `HashMap<String, JsonValue>`**
   — the repo does not define `projectlessWorkspaceRoot` at all.
5. **`thread/start` persists nothing.** Persistence is lazy: "Fresh threads have no rollout
   until their first turn." So an abandoned compose surface cannot create an orphan thread
   *unless* you touch a materializing call (`thread/fork`, `thread/archive`,
   `thread/read` with `includeTurns` on a paginated thread).
6. There is **no garbage collector for empty threads** anywhere in the app-server crate.

---

## 1. Two unrelated things are called "project"

Confusing them is the main trap here.

### 1.1 `[projects]` in `config.toml` = trust only

`codex-rs/config/src/config_toml.rs:477`

```rust
    pub projects: Option<HashMap<String, ProjectConfig>>,
```

`codex-rs/config/src/config_toml.rs:618-621` — the entire per-project payload:

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ProjectConfig {
    pub trust_level: Option<TrustLevel>,
}
```

`deny_unknown_fields` means a `[projects.'…']` stanza **cannot** carry a title, id, position or
anything else. It is a trust switch keyed by a canonicalised path.

The writer that produces the stanza you saw is
`codex-rs/core/src/config/mod.rs:2417-2432`:

```rust
pub(crate) fn set_project_trust_level_inner(
    doc: &mut DocumentMut,
    project_path: &Path,
    trust_level: TrustLevel,
) -> anyhow::Result<()> {
    // Ensure we render a human-friendly structure:
    //
    // [projects]
    // [projects."/path/to/project"]
    // trust_level = "trusted" or "untrusted"
```

…and it is called from `thread/start`, not from any "create project" flow
(`codex-rs/app-server/src/request_processors/thread_processor.rs:1407-1455`):

```rust
            // Project-local config can launch host processes, so only the effective
            // permissions after managed constraints can imply project trust.
            let effective_permissions_trust_project = match &effective_permission_profile {
    ...
                && config.active_project.trust_level.is_none()
                && !config.config_layer_stack.is_projectless()
                && effective_permissions_trust_project
            {
                let trust_target = resolve_root_git_project_for_trust(LOCAL_FS.as_ref(), &config.cwd)
    ...
                    codex_core::config::set_project_trust_level(
    ...
            "failed to persist trusted project state for {}; continuing with in-memory trust for this thread: {err}",
```

So: **starting a thread with a `cwd` and a permissive sandbox writes a `[projects.…]` stanza
into the user's `config.toml`.** That stanza is a side effect of `thread/start`, not a project
record. The app-server README (v0.165.0, `codex-rs/app-server/README.md:175-180`) confirms the
scope of that behaviour:

> # Project trust
>
> `thread/start` does not persist project trust for a directory where configuration
> discovery finds no project-root marker, Git checkout, or project-local `.codex`
> directory. Starting a task there does not preapprove project configuration added
> later. Existing trust decisions and permission checks for projects are unchanged.

The concept that "project = the trust scope for a cwd" is `Config::active_project`
(`codex-rs/core/src/config/mod.rs:1172-1173`):

```rust
    /// The currently active project config, resolved by checking if cwd:
    /// is (1) part of a git repo, (2) a git worktree, or (3) just using the cwd
    pub active_project: ProjectConfig,
```

`is_projectless()` is computed in `codex-rs/config/src/loader/mod.rs:418-420` and stored at
`:507`:

```rust
        is_projectless = !project_trust_context.has_project_root_marker
            && project_trust_context.checkout_root.is_none()
            && project_layers.layers.is_empty();
```

This `projectless` flag is **about config discovery**, i.e. "this cwd has no project-local
config layer". It is not the desktop's `projectlessWorkspaceRoot` setting (§1.2).

### 1.2 `[desktop]` is opaque to the repo

`codex-rs/config/src/config_toml.rs:551-553`:

```rust
    /// Opaque desktop settings stored alongside the rest of config.toml.
    #[serde(default)]
    pub desktop: Option<HashMap<String, JsonValue>>,
```

There is **no** struct, field or reader for `projectlessWorkspaceRoot` anywhere in
`codex-rs` at v0.165.0 (I grepped `core/src/config/mod.rs`,
`config/src/config_toml.rs`, `config/src/loader/mod.rs` and the app-server crate). The
semantics of `[desktop] projectlessWorkspaceRoot` are owned entirely by the closed-source
desktop client and **cannot be determined from this repository** — see §7.

Practical consequence: writing or reading `[desktop] projectlessWorkspaceRoot` through the
app-server is only possible as an opaque blob (`config/read` → `config.desktop`, or
`config/value/write`). Nothing server-side reacts to it.

---

## 2. The real project data model

### 2.1 The wire types

`codex-rs/app-server-protocol/src/protocol/v2/project.rs` (whole file is 195 lines; these are
the load-bearing parts).

`:22-36`:

```rust
pub struct Project {
    pub id: String,
    pub name: String,
    pub roots: Vec<ProjectRoot>,
    pub metadata: BTreeMap<String, String>,
    #[ts(type = "number")]
    pub position: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    /// Newest non-archived member thread's recency, in Unix seconds; null when none exist.
    #[ts(type = "number | null")]
    pub recency_at: Option<i64>,
}
```

`:15-17` — a project may have **several roots**:

```rust
pub struct ProjectRoot {
    pub path: AbsolutePathBuf,
}
```

`:41-44` — sidebar ordering supports two modes:

```rust
pub enum ProjectSortKey {
    Position,
    RecencyAt,
}
```

`:49-60` — the list request (note the pagination and the empty-project rule):

```rust
pub struct ProjectListParams {
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    /// Defaults to position. Recency sorting always places empty projects last.
    #[ts(optional = nullable)]
    pub sort_key: Option<ProjectSortKey>,
    /// Requires sortKey. Defaults to asc for position and desc for recencyAt.
    #[ts(optional = nullable)]
    pub sort_direction: Option<SortDirection>,
}
```

`:65-68`:

```rust
pub struct ProjectListResponse {
    pub data: Vec<Project>,
    pub next_cursor: Option<String>,
}
```

`name`, `roots` and `metadata` are the only mutable fields
(`ProjectUpdateParams`, `:125-133`):

```rust
pub struct ProjectUpdateParams {
    pub project_id: String,
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[ts(optional = nullable)]
    pub roots: Option<Vec<ProjectRoot>>,
    #[ts(optional = nullable)]
    pub metadata: Option<BTreeMap<String, String>>,
}
```

### 2.2 The full RPC surface

`codex-rs/app-server-protocol/src/protocol/common.rs:797-837` — every one is `experimental`:

```rust
#[experimental("project/list")]
ProjectList => "project/list" {
    params: v2::ProjectListParams,
    serialization: global_shared_read("projects"),
    response: v2::ProjectListResponse,
},
#[experimental("project/read")]
ProjectRead => "project/read" { … }
#[experimental("project/create")]
ProjectCreate => "project/create" {
    params: v2::ProjectCreateParams,
    serialization: global("projects"),
    response: v2::ProjectCreateResponse,
},
#[experimental("project/import")]
ProjectImport => "project/import" { … }
#[experimental("project/update")]
ProjectUpdate => "project/update" { … }
#[experimental("project/move")]
ProjectMove => "project/move" { … }
#[experimental("project/delete")]
ProjectDelete => "project/delete" { … }
```

Notifications, `common.rs:1994-1997`:

```rust
#[experimental("project/changed")]
ProjectChanged => "project/changed" (v2::ProjectChangedNotification),
#[experimental("thread/project/updated")]
ThreadProjectUpdated => "thread/project/updated" (v2::ThreadProjectUpdatedNotification),
```

Bodies (`codex-rs/app-server-protocol/src/protocol/v2/project.rs:180-195`):

```rust
pub struct ProjectChangedNotification {
    pub project_id: String,
    pub change_type: ProjectChangeType,      // "created" | "updated" | "deleted"
}

pub struct ThreadProjectUpdatedNotification {
    pub thread_id: String,
    pub project_id: Option<String>,          // null = thread is now unassigned
}
```

`codex-rs/app-server/src/request_processors/projects.rs:267-289` shows exactly when they fire —
`project/changed` after a *changed* create/update/move/delete, and
`thread/project/updated` **once per affected thread** on import/delete:

```rust
    async fn notify_thread_projects(&self, thread_ids: Vec<String>, project_id: Option<String>) {
        for thread_id in thread_ids {
            self.outgoing
                .send_server_notification(ServerNotification::ThreadProjectUpdated(
                    ThreadProjectUpdatedNotification {
                        thread_id,
                        project_id: project_id.clone(),
                    },
                ))
                .await;
        }
    }
```

### 2.3 Where projects are actually stored

Not `config.toml`. They are records in the **local SQLite thread store**:

`codex-rs/thread-store/src/store.rs:447-450`

```rust
    /// Whether this store supports durable host-owned projects.
    fn supports_projects(&self) -> bool {
        false
    }
```

"durable host-owned" — and the default is `false`, i.e. the in-memory store has no projects,
only `LocalThreadStore` (SQLite) does. The store crate's own docs
(`codex-rs/thread-store/src/lib.rs:1-5`) say the DB "mirrors it into a local SQLite database".

If the store is not SQLite-backed, every project method degrades to *method not found*
rather than silently working (`codex-rs/app-server/src/request_processors/projects.rs:389-393`):

```rust
fn project_store_error(operation: &'static str, error: ThreadStoreError) -> JSONRPCErrorError {
    match error {
        ThreadStoreError::Unsupported { .. } => {
            method_not_found(format!("{operation} is unavailable without sqlite state"))
        }
```

So your client must treat `project/*` as **optional capability**, not as guaranteed.

`project/create` is idempotent (`ProjectCreateParams` requires `idempotency_key`,
`project.rs:84-93`), and ids are server-assigned opaque strings.

`project/import` is the "adopt existing threads" call
(`project.rs:102-113`) — it takes the same `name`/`roots`/`metadata` plus
`threads: Option<Vec<String>>`, and the handler then emits `thread/project/updated` for each
(`projects.rs:154-176`).

`project/move` is drag-to-reorder in the sidebar (`project.rs:142-154`):

```rust
pub struct ProjectMoveParams {
    pub project_id: String,
    #[ts(optional = nullable)]
    pub before_project_id: Option<String>,
}
```

`project/delete` does **not** delete threads; it only unassigns them
(`projects.rs:224-240`, `notify_thread_projects(deleted.affected_active_thread_ids, None)`).

### 2.4 Why our bindings only have `project/changed` + `Thread.projectId`

This is not a gap in the server — it is how the TypeScript bindings were generated.

`codex-rs/app-server-protocol/src/export.rs:105-121`:

```rust
#[derive(Clone, Copy, Debug)]
pub struct GenerateTsOptions {
    pub generate_indices: bool,
    pub ensure_headers: bool,
    pub run_prettier: bool,
    pub experimental_api: bool,
}

impl Default for GenerateTsOptions {
    fn default() -> Self {
        Self {
            generate_indices: true,
            ensure_headers: true,
            run_prettier: true,
            experimental_api: false,
        }
    }
}
```

`export.rs:142-143`:

```rust
    if !options.experimental_api {
        filter_experimental_ts(out_dir)?;
    }
```

`filter_experimental_ts` (`export.rs:267-275`) removes the experimental **request** union
members and their params/response types, and `filter_experimental_type_fields_ts` removes
**field-level** experimental fields. Notifications are not in that filter list, which is
exactly what our tree shows:

* `codex-remote/protocol/ServerNotification.ts:93` **does** contain
  `{"method":"project/changed",…}` and `{"method":"thread/project/updated",…}`.
* `codex-remote/protocol/ClientRequest.ts` contains **zero** occurrences of `project`.
* `codex-remote/protocol/v2/ThreadListParams.ts` and `ThreadStartParams.ts` have no
  `projectId`, because of `#[experimental("thread/list.projectId")]` /
  `#[experimental("thread/start.projectId")]` field gates
  (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:127`, `:1462`).
* `codex-remote/protocol/v2/Thread.ts` **does** have `projectId`, with doc
  `"Canonical project assignment owned by app-server, if any."` — the field itself is stable.

Verified against the published schema with HTTP status checks (identical results at
`rust-v0.165.0` and `@main`):
`…/schema/typescript/v2/Project.ts` → 200, `…/ThreadSection.ts` → 200,
`…/ProjectListParams.ts` → **404**, `…/ProjectListResponse.ts` → **404**.

Runtime gating is separate and must be done at `initialize`
(`codex-remote/protocol/InitializeCapabilities.ts`):

```ts
  /**
   * Opt into receiving experimental API methods and fields.
   */
  experimentalApi: boolean,
```

`codex-rs/app-server/src/message_processor.rs:1003-1007`:

```rust
        if let Some(reason) = codex_request.experimental_reason()
            && !session.experimental_api_enabled()
        {
            return Err(invalid_request(experimental_required_message(reason)));
        }
```

with `codex-rs/app-server-protocol/src/experimental_api.rs:30-32`:

```rust
pub fn experimental_required_message(reason: &str) -> String {
    format!("{reason} requires experimentalApi capability")
}
```

So without the capability you get JSON-RPC `invalid_request` (code `-32600`) whose message is
literally e.g. `project/list requires experimentalApi capability`.

---

## 3. How a thread gets its project

### 3.1 Explicitly, at creation

`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:125-129`:

```rust
    /// Optional project identity for this new thread. Durable threads persist
    /// the assignment; ephemeral threads expose it only in live responses.
    #[experimental("thread/start.projectId")]
    #[ts(optional = nullable)]
    pub project_id: Option<String>,
```

Validated before use — `thread_processor.rs:1237-1252`:

```rust
        if let Some(project_id) = project_id.as_ref() {
            if project_id.is_empty() {
                return Err(invalid_request("projectId must not be empty"));
            }
            let project = self
                .thread_store
                .read_project(project_id.clone())
    ...
            if project.is_none() {
                return Err(invalid_request(format!("project not found: {project_id}")));
```

and echoed into the created thread at `:1630`:

```rust
        thread.project_id = project_id.clone();
```

### 3.2 Explicitly, later — `thread/metadata/update`

There is **no** `thread/projectUpdate` / `thread/updateProject` method. The assignment is a
field on the existing metadata update (`thread.rs:1045-1051`):

```rust
pub struct ThreadMetadataUpdateParams {
    pub thread_id: String,
    /// Omit to leave the project unchanged, use an empty string to clear it,
    /// or provide an existing project ID to assign it.
    #[experimental("thread/metadata/update.projectId")]
    #[ts(optional = nullable)]
    pub project_id: Option<String>,
```

Server side (`thread_processor.rs:1989-2107`) it re-validates the project, compares against
`previous_project_id`, and emits `thread/project/updated` only when the value actually changed:

```rust
        if let Some(project_id) = project_update.as_ref()
            && previous_project_id.as_ref() != Some(project_id)
        {
            ...
                .send_server_notification(ServerNotification::ThreadProjectUpdated(
                    ThreadProjectUpdatedNotification {
                        ...
                        project_id: project_id.clone(),
```

### 3.3 By inheritance on fork

`thread_processor.rs:5663-5671` and `:5860`:

```rust
        let inherited_project_id = source_thread.project_id.clone();
    ...
            project_id: inherited_project_id.clone().map(Some),
    ...
        thread.project_id = inherited_project_id.clone();
```

### 3.4 It is **not** derived from `cwd` — verified by absence

In the whole 6886-line `thread_processor.rs`, `read_project` appears at exactly four places
(`:1243`, `:2001`, `:2730`) — all of them *validating a client-supplied id* — plus the
`supports_projects()` gate at `:2723`. There is no code path that maps `cwd` → project,
no `roots`-based lookup, and no "assign on first turn" hook. `cwd` and `projectId` are
orthogonal; `cwd` remains "Working directory captured for the thread"
(`codex-remote/protocol/v2/Thread.ts`, `cwd` field).

A thread with `projectId: null` is legal and listable (`thread/list` can filter for exactly
those, §3.5). The desktop's notion of a "projectless" thread is just `projectId == null`.

### 3.5 Filtering and reading by project

`thread.rs:1460-1470`:

```rust
    /// Omit to include every project, set to null for unassigned threads,
    /// or provide a project ID to return only threads in that project.
    #[experimental("thread/list.projectId")]
    ...
    #[ts(optional = nullable, type = "string | null")]
    pub project_id: Option<Option<String>>,
```

It is a **double option on purpose**: absent = all projects, `null` = only unassigned,
`"<id>"` = that project. `thread/list` also has a `cwd` filter (`:1471-1474`), so the two axes
can be filtered independently — useful when a project has several roots.

The handler validates the id and returns a clean error for unknown projects
(`thread_processor.rs:2723-2742`):

```rust
        if project_id.is_some() && !self.thread_store.supports_projects() {
            return Err(unsupported_thread_store_operation("projects"));
        }
        if let Some(Some(project_id)) = project_id.as_ref() {
            ...
                    return Err(invalid_params(format!("project not found: {project_id}")));
```

Note the asymmetry worth knowing: `thread/list` with `projectId` uses `invalid_params`
(`-32602`), while `thread/start` uses `invalid_request` (`-32600`) for the same condition.

---

## 4. How "Projects" entries are named

The server **never derives a name**. `project/create` and `project/import` both require a
`name: String`, and the only server-side processing is trim-and-reject-empty
(`codex-rs/app-server/src/request_processors/projects.rs:303-309`):

```rust
fn validate_name(name: String) -> Result<String, JSONRPCErrorError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(invalid_params("project name must not be empty"));
    }
    Ok(name)
}
```

It is stored as given (`api_project`, `:363-387`, passes `name: project.name` straight
through). Root paths are validated and de-duplicated *within one request*
(`validate_roots`, `:321-351`, including a canonicalised-duplicate check), but nothing links
a name to a root.

Therefore:

* The sidebar label is **not** a config key. `[projects.'C:\…']` never feeds the label.
* The label is **whatever the client sent** as `name`. The desktop almost certainly sends the
  folder basename when it first sees a directory, but that derivation, if it exists, is in the
  closed-source client and **cannot be confirmed here** (see §7).
* Renaming is `project/update{name}`; `project/changed{changeType:"updated"}` follows.
* Sidebar order is `position` (manual, via `project/move{beforeProjectId}`) or `recencyAt`
  ("Recency sorting always places empty projects last").

For a browser client, the pragmatic rule: **you are the namer.** Use the folder basename first,
keep it editable via `project/update`, and persist any extra display state (colour, icon,
collapsed) in `metadata` (`BTreeMap<String,String>`, round-trips untouched).

---

## 5. New-thread lifecycle

### 5.1 `thread/start` persists nothing

The store contract for "make this thread durable" is
`codex-rs/thread-store/src/store.rs:224-231`:

```rust
    /// Materializes the thread if persistence is lazy, then persists all queued items.
    ///
    /// Preparation checkpoints may leave disposable preparation data in memory without
    /// activating storage. Standard persistence must complete before returning. Contexts that allow background
    /// persistence may complete asynchronously …
    fn persist_thread(
        &self,
        thread_id: ThreadId,
        context: PersistContext,
    ) -> ThreadStoreFuture<'_, ()>;
```

"if persistence is lazy" — it is. The clearest statement is a comment in the archive handler
(`thread_processor.rs:1774-1783`) which has to work around it:

```rust
        // Fresh threads have no rollout until their first turn. Materialize the
        // loaded persistent thread before looking it up for archival.
        if let Ok(thread) = self.thread_manager.get_thread(thread_id).await
            && !thread.config_snapshot().await.ephemeral
        {
            self.thread_store
                .persist_thread(thread_id, PersistContext::Standard)
                .await
```

`thread/start` instead only **reserves** an id and stages the initial metadata **in memory**.
`thread_processor.rs:1528-1545`:

```rust
        let reserved_thread_id = if start_options.config.ephemeral {
            None
        } else {
            stage_pending_thread_metadata(
                listener_task_context.thread_manager.as_ref(),
                thread_store.as_ref(),
                StoreThreadMetadataPatch {
                    project_id: project_id.clone().map(Some),
                    daybreak_enabled,
                    ..Default::default()
                },
                "thread/start",
            )
            .await?
        };
        let thread_id = reserved_thread_id
            .unwrap_or_else(|| listener_task_context.thread_manager.reserve_thread_id());
```

and the store docstring for that staging (`codex-rs/thread-store/src/store.rs:143-149`):

```rust
    /// Stages host-owned metadata for a thread ID reserved before Core starts the thread.
    ///
    /// The entry remains in memory until the first successful metadata update for that thread.
    /// Callers must remove it if startup fails before the store opens a live thread.
```

**In memory** — so a reserved id is invisible to `thread/list`, which reads only the store
(`thread_processor.rs:6020-6038`, `self.thread_store.list_threads(...)`).

The app-server README states the same guarantee for the sibling feature
(`codex-rs/app-server/README.md:110-117`):

> Persistent threads accept `daybreakEnabled` on `thread/start` with the
> `experimentalApi` opt-in. … The choice is staged
> with the thread's other initial metadata and saved when the thread is persisted.
> An unused thread is not guaranteed to survive restart.

**Conclusion:** a `thread/start`ed thread with zero turns
* is absent from `thread/list`,
* leaves no rollout file,
* **disappears entirely on app-server restart**,
* and `thread/start` rollback is explicit on failure (`thread_processor.rs:1586-1591`):

```rust
            Err(err) => {
                listener_task_context
                    .thread_state_manager
                    .remove_thread_state(thread_id)
                    .await;
                remove_pending_thread_metadata(thread_store.as_ref(), reserved_thread_id).await;
```

### 5.2 When it *does* become durable

Only calls that force materialisation:

| Trigger | Evidence |
|---|---|
| First successful turn | `store.rs:224` "Materializes the thread if persistence is lazy, then persists all queued items"; `thread_processor.rs:1774` "Fresh threads have no rollout until their first turn" |
| `thread/archive` | `thread_processor.rs:1779` explicit `persist_thread` |
| `thread/read` with `includeTurns` **and** paginated history mode | `thread_processor.rs:3252-3260` |
| `thread/fork` of a persistent source | `thread_processor.rs:5798` "Persistent forks materialize their own rollout immediately" |
| `thread/metadata/update` (projectId/gitInfo) | `thread_processor.rs:2055-2091` writes through the store — **inferred**, see §7 |

### 5.3 What happens when the first turn fails

Two distinct cases, and they behave differently.

**(a) The `turn/start` request itself is rejected.** All the validation happens before any
op is submitted (`thread_processor.rs:532-582`: thread loaded, direct-input allowed, provider
config valid, input size within `MAX_USER_INPUT_TEXT_CHARS`). If it errors, nothing is
persisted and the thread stays un-materialised — i.e. **no orphan in `thread/list`**.

**(b) The turn starts and then fails** (quota / rate limit / provider error). By then the turn
is in flight, items are queued through the store, and the thread materialises. It then shows
up in `thread/list` as a real thread with a failed turn
(`ThreadStartResponse`/`TurnCompletedNotification` carry `TurnError`). **Nothing rolls it
back** — I found no delete/archive-on-failure path in `thread_processor.rs`,
`turn_processor.rs` or `connection_cleanup.rs` (`connection_cleanup.rs` only reaps
`JoinSet` tasks).

So the answer to "is a quota-failed first turn rolled back?" is: **no.** But if the quota check
happens before the turn is admitted, you get case (a) and nothing is written at all.

### 5.4 `ephemeral` threads

`thread.rs:114-115` — a plain optional flag on `thread/start` (and on `thread/fork`):

```rust
    #[ts(optional = nullable)]
    pub ephemeral: Option<bool>,
```

Effects, all quoted from `thread_processor.rs`:

* No id reservation, no staged metadata (`:1528-1530`); no rollout; `Thread.path == null`
  (`codex-remote/protocol/v2/Thread.ts`: *"Whether the thread is ephemeral and should not be
  materialized on disk"*).
* `thread/read` with `includeTurns` is rejected (`:3219-3222`):
  `"ephemeral threads do not support includeTurns"`.
* `thread/turns/list` is rejected (`:3807-3810`):
  `"ephemeral threads do not support thread/turns/list"`.
* `thread/revert` is rejected (`:2207-2211`): `"ephemeral threads do not support thread/revert"`.
* `thread/delete` is rejected (`request_processors/thread_delete.rs:90-97`):
  `"thread is not persisted and cannot be deleted: {thread_id}"`.
* Cannot save `daybreakEnabled` (`:1402-1405`, README `:117` "Ephemeral threads cannot save it").
* No paginated history mode by default (`:1519-1522`).
* Project assignment is **not** persisted — `thread.rs:125-127`:
  *"Durable threads persist the assignment; ephemeral threads expose it only in live
  responses."*

**What the desktop uses it for: cannot be determined from this repo** (§7). The only
repo-visible hint is that experiment/prediction paths require it — `thread_processor.rs:5269-5271`:

```rust
        if params.experimental_prediction_mode && !params.ephemeral {
            return Err(invalid_params(
                "`experimentalPredictionMode` requires `ephemeral: true`",
```

i.e. ephemeral exists to run throwaway model work (prediction/ghost-text style) that must never
pollute the user's thread list.

### 5.5 Is there any code that cleans up empty threads?

**No.** Grepping the app-server crate for `empty_thread`, `no_turns`, `discard`, `prune`,
`unused` and reading `connection_cleanup.rs` (49 lines, purely a `JoinSet` reaper) turns up
nothing. Empty threads are excluded from listings **structurally** (they have no store row),
not by a filter. Two caveats that matter for a client:

1. `thread/list` has an explicit escape hatch that *does* include empty threads
   (`thread.rs:1492-1497`):

```rust
    /// Return only persistent threads attached to this thread, including empty threads.
    /// Mutually exclusive with parentThreadId and ancestorThreadId.
    /// Omitting this filter keeps attached threads hidden from ordinary listings.
    #[experimental("thread/list.attachedToThreadId")]
```

2. There is no "delete if never used" rule anywhere, so **an empty thread that got
   materialised stays forever** until the client archives/deletes it.

Deletion itself is client-driven (`thread_delete.rs:31-73`), destructive, and also removes
spawned descendants (`state_db_spawn_subtree_thread_ids`). Archive is the safer primitive and
it materialises-then-archives, which is why it works on a fresh thread.

---

## 6. Concrete recommendation for the browser client

### 6.1 Enable the project API (two separate switches)

1. **Codegen:** regenerate the bindings with experimental types included —
   `codex app-server generate-ts --out codex-remote/protocol` must be run with the
   experimental flag (see `GenerateTsOptions::experimental_api`, `export.rs:105-121`).
   Verify the flag name with `codex app-server generate-ts --help`; the option exists in the
   exporter for certain but I could not read the CLI arg parser from the mirrors (§7).
   Success check: `protocol/v2/ProjectListParams.ts` appears and `ClientRequest.ts` gains
   `{"method":"project/list",…}`.
2. **Session:** at `initialize`, send `capabilities.experimentalApi: true`. Otherwise every
   `project/*` call fails with `-32600 project/list requires experimentalApi capability`
   (`message_processor.rs:1003-1007`). Keep this behind a feature probe: if
   `project/list` returns `-32601 method_not_found` — which happens on a non-SQLite store,
   `projects.rs:389-393` — fall back to a `cwd`-only sidebar.

### 6.2 Discover projects

```
→ project/list { limit: 100, sortKey: "position" }         // sidebar order
← { data: Project[], nextCursor }
```

Render order: `position` when the user has not reordered by activity, `recencyAt` for an
"Active" sort — the server already guarantees empty projects sort last for `recencyAt`
(`project.rs:54`). Paginate with `nextCursor` (`limit` is clamped to
`THREAD_LIST_DEFAULT_LIMIT`/`MAX_LIMIT` = 25/100 via `THREAD_LIST_DEFAULT_LIMIT`,
`thread_processor.rs:46-47`).

Then, per visible project, fetch its threads:

```
→ thread/list { projectId: "<id>", limit: 20, sortKey: "recencyAt", sortDirection: "desc" }
```

Do **not** call `thread/list` with `cwd` instead of `projectId` unless you deliberately want
"every thread whose cwd is this folder, regardless of project assignment" — the two filters are
independent (§3.5).

Subscribe to `project/changed` (refetch that project or the whole page) and
`thread/project/updated` (move/remove one thread node). Both survive non-experimental
binding generation, so you may already be receiving them; if you are not, they will start
arriving once `experimentalApi` is on.

### 6.3 Create a project for a folder

```
→ project/create {
    name: basename(root),                                  // you own the label (§4)
    roots: [{ path: root }],
    metadata: { "app": "codex-remote", "icon": "folder" },
    idempotencyKey: crypto.randomUUID()                    // required, non-empty, ≤512 B
  }
← { project: Project }
```

Rules the server enforces (`projects.rs:303-351`): name trimmed/non-empty; every root must be
an **absolute** path (a relative one is rejected with `invalid project root`); duplicate roots —
including canonicalised symlink duplicates — inside one request are rejected. Always send a
stable `idempotencyKey` per user gesture so a retried POST does not create a second project.

To adopt already-existing threads into a new project (e.g. the user's existing `cwd` history),
use `project/import` with `threads: [...]` instead of `create` + N × `thread/metadata/update`.

### 6.4 Start a thread in the chosen project

```
→ thread/start {
    cwd: "<project.roots[0].path>",     // the sandbox/working directory
    projectId: "<project.id>",          // the sidebar assignment
    ephemeral: false
  }
```

* `cwd` and `projectId` must both be sent. `cwd` is what the agent actually works in
  (`Thread.cwd`); `projectId` only decides which sidebar bucket the thread appears under. The
  server will not infer either from the other (§3.4).
* Beware the trust side effect: if the resolved sandbox is `workspace-write`/full access, this
  call **rewrites the user's `config.toml`** with
  `[projects.'<git-or-cwd-root>'] trust_level = "trusted"`
  (`thread_processor.rs:1407-1455`). If your client sets a restrictive sandbox, no write occurs.
  Surface this in your UI or pick your default sandbox deliberately.
* If you want "a thread that is not yet real", pass `ephemeral: true` — it emits
  `thread/started` with `Thread.ephemeral === true` and `Thread.path === null`, and never
  appears in `thread/list`.

### 6.5 One compose surface without orphans — the actual recipe

The desktop's "clicking New chat returns to the same composer" is achievable here almost for
free, because **`thread/start` is not a write**. Do this:

1. **On "New chat": call nothing.** Keep a single client-side draft state
   `{ projectId, cwd, model, text }`. Render the composer. No id exists yet, therefore no
   orphan is possible by construction.
2. **On first send:** `thread/start` with the draft's `projectId` + `cwd`, then immediately
   `turn/start` with the text. Because both happen in one user gesture, a rejected turn
   (§5.3 case a) leaves an un-materialised thread that (a) is invisible to `thread/list` and
   (b) is dropped on app-server restart. Nothing to clean up.
3. **If you must pre-create** (e.g. to stream `thread/started` into the UI, or to bind the
   composer to a real id for attachments): that is still safe — the id stays in memory only —
   **but** then make sure you never call `thread/fork`, `thread/archive`, or
   `thread/read{includeTurns:true}` on it, because those materialise it permanently
   (§5.2), and nothing will ever garbage-collect it (§5.5).
4. **After a failed first turn** (§5.3 case b): the thread is now durable and will show in
   `thread/list`. Decide deliberately:
   * keep it (it is a real conversation with an error — the desktop behaviour you described
     implies the composer returns to draft instead, so users will not see it);
   * or clean it up with `thread/archive` (reversible, appears under Archived) rather than
     `thread/delete` (destroys the rollout and any spawned descendants,
     `thread_delete.rs:39-65`).

   Do **not** try `thread/delete` on a thread that was never materialised — the delete path
   does not materialise first, unlike archive (§7).

5. **Because abandoned drafts are not persisted, do not promise durability.** Send the draft to
   `localStorage` yourself if the user expects a refresh to keep it; the server's guarantee is
   the opposite ("An unused thread is not guaranteed to survive restart").

Sketch of the send path:

```js
// one compose surface; nothing is created until the user commits
async function sendFirstMessage(draft) {
  const { thread } = await rpc('thread/start', {
    cwd: draft.rootPath,              // project root
    projectId: draft.projectId,       // sidebar bucket
    ephemeral: false,
  });
  try {
    return await rpc('turn/start', { threadId: thread.id, input: toUserInput(draft.text) });
  } catch (err) {
    // Two cases (§5.3). Track admission yourself: set `admitted = true` when the
    // `turn/started` notification for thread.id arrives, or when turn/start resolved.
    //  - not admitted  -> nothing was written; the thread vanishes on restart. Nothing to do.
    //  - admitted+fail -> the thread is durable and will appear in thread/list.
    if (admitted) await rpc('thread/archive', { threadId: thread.id }); // reversible; prefer over delete
    throw err;
  }
}
```

And the sidebar reload path, which is also the reconciliation loop:

```js
const projects = await rpc('project/list', { limit: 100, sortKey: 'position' });
const byProject = await Promise.all(projects.data.map(p =>
  rpc('thread/list', { projectId: p.id, limit: 20, sortKey: 'recencyAt', sortDirection: 'desc' })
));
// unassigned threads, if the UI wants an "Other" bucket:
const unassigned = await rpc('thread/list', { projectId: null, limit: 20 });
```

### 6.6 Minimum viable fallback

If `project/*` is unavailable (`-32601` on a non-SQLite store) or `experimentalApi` cannot be
negotiated, degrade to `cwd`-based grouping without changing the rest of the design:

```
→ thread/list { cwd: [root1, root2, ...], limit: 20 }     // cwd accepts string | string[]
```

Group the response by `thread.cwd`, label each group by `basename(cwd)`, and keep the draft's
`cwd` as the only state. Everything in §6.5 still holds, since it never depends on
`projectId`.

---

## 7. Explicitly undetermined

These I could **not** establish from the public repository and are **not** guesses above:

1. **`[desktop] projectlessWorkspaceRoot` semantics.** `pub desktop: Option<HashMap<String,
   JsonValue>>` (`config_toml.rs:551-553`) is the only definition; no code reads the key. Which
   folder "projectless" threads use, and whether the desktop shows them in the Projects
   sidebar, lives in the closed-source desktop app.
2. **How the desktop renders unnamed/empty project entries**, and whether it derives a label
   from a folder basename before calling `project/create`. The server has no naming logic
   (§4), so the derivation — if any — is client-side and invisible here.
3. **What the desktop actually uses `ephemeral: true` for.** Only the repo-visible constraint
   is `experimentalPredictionMode requires ephemeral: true`
   (`thread_processor.rs:5269-5271`).
4. **The exact CLI flag** that maps to `GenerateTsOptions::experimental_api`. The option exists
   (`export.rs:105-121`) and `codex-rs/app-server-protocol/src/bin/export.rs` exists in the
   `main` tree listing but returned 404 when fetched at both refs, so I could not read the arg
   parser. Check `codex app-server generate-ts --help`.
5. **Whether `thread/metadata/update{projectId}` materialises a never-persisted thread.** It
   writes through the store (`thread_processor.rs:2055-2091`) but I did not see the store's
   `update_thread_metadata` implementation, so the materialisation behaviour is inferred, not
   quoted.
6. **Whether `thread/delete` succeeds on a never-materialised thread.** `validate_root_thread_delete`
   accepts a loaded non-ephemeral thread (`thread_delete.rs:90-97`) but the path does *not*
   call `persist_thread`, unlike archive (`thread_processor.rs:1774-1783`), so it plausibly then
   fails with `thread not found`. Untested.
7. **Whether `project/create` rejects a root path already owned by another project.** Only
   intra-request duplicate detection is implemented/visible (`projects.rs:321-351`); the state
   layer's uniqueness constraints were not read. Assume duplicates across projects are allowed.
8. **Version drift beyond `@main`.** Everything above is `rust-v0.165.0`, cross-checked against
   `@main` (identical `project.rs`, same 7 methods, and `ProjectListParams.ts` /
   `ProjectListResponse.ts` still 404 in the published `schema/typescript/v2/` at `@main`, i.e.
   the experimental filtering is current behaviour). `rust-v0.166.0` was not fetchable from the
   mirrors, so a ref newer than `@main` may have graduated these methods out of experimental.
   Re-verify against the exact `codex --version` you run, as `reference-architecture.md` already
   warns.

# AGENTS.md

## Doc & SSOT (single source of truth)

There should be 4 kind of documents in `docs`, organized by domain (sub-project):

**spec.md**: Product spec

- SSOT of the expected product behavior, user journeys, features, tech/non-tech requirements to meet, etc
- This is the golden SSOT, all other kind of docs must conform to it
- "Tech Notes" section can be kept if necessary as a guideline for tech design, only added by user request
- Should be only updated by explicit user requests

**design.md**: Tech design

- SSOT of the technical choice, considerations, architecture, direction, implicit contract, invariants, etc
- Must NOT contain detailed steps or implementation details, unless related code is complex and needs to be explained
- Update the doc when tech direction / decisions evolve
- Fundamental tech direction, stack or architecture change should be only updated by explicit user requests
- Tech impl details and code must conform to tech design

**test.md**: Test design

- One-sentence description of each _end to end_ test case
- Served both as an index and a guide for future test writing
- Should be updated accordingly

**impl.md**: Optional: Tech impl doc

- The desired implementation details
- This doc is for developing new features, remove after impl is finished - let code speak for itself

Docs should be hierarchical:

```
docs/
├── ssot/             # Source of truth (current behavior)
│   └── <domain>/
|       ├── spec.md
|       ├── design.md
│       └── test.md
├── changes/          # Proposed updates (one folder per change)
│   └── <yyyy-mm-dd-change-name>/
│       ├── spec.md
│       ├── design.md
│       ├── test.md
│       └── impl.md
├── spec.md           # overall top-level spec, providing overall design and direction. All other docs
│                     # must conform to it. It may not be complete, only cover most important parts.
├── design.md         # overall top-level tech design, some most important tech direction and architecture.
│                     # All other tech design docs must conform to it.
└── README.md         # documentation structure overview and reading guide
```

It is possible that even product spec or tech design is overly complex or contain obvious mistakes.
Simplify or improve these docs proactively when you are confident, based on your best judgment over
the first principles and Ockham's principle.

All docs must follow these rules in addition:

- Keep words simple and sentences concise
- Keep well-structured and organized, easy to read
- No duplication or redundancy
- Use English as all docs language

When introducing a notable change, make sure all involved docs are updated accordingly:

- `docs/ssot/<domain>/*`
- `docs/changes/<change_name>/*`   <- only about this change
- `docs/spec.md`, `docs/design.md` <- update only if you are very sure it conflicts with the new change or by user request

No need to produce change proposal docs for small or trivial changes, but make sure to update the
SSOT docs in `docs/ssot/<domain>/*` accordingly if necessary.

### Knowledge Base (`.codexpotter/kb/`)

- KB is not SSOT. If a fact is already covered by `docs/**`, or clearly belongs in spec / design / test / impl docs, update the proper doc instead of copying it into KB.
- KB should only keep current, reusable facts that are not already documented elsewhere and are not a good fit for SSOT docs.
- Remove stale KB entries proactively.

## Critical Engineering Rules

This project requires extremely high code quality and maintainability. Best engineering practices
MUST BE followed at all times. There is zero tolerance for sloppy, unclear, or over-engineered code,
once discovered it MUST BE refactored immediately.

The rules below are some typical principles that you **MUST follow**. They are not exhaustive, and
you must always use your best judgment to **write the cleanest code possible**.

### Core Principles: Simplicity & Readability

- Boring Code - Obvious, self-explanatory > clever, minimize cognitive load
- Single Responsibility - One function, one job
- Only What's Used - No future-proofing, delete dead code immediately
- Explicit over Implicit - Clear is better than concise
- Meaningful Abstractions - Only when they reduce cognitive load
- Keep DRY - Only if it does not conflict with the above principles

### Better Maintainability

- Don't treat "looks similar" as "equivalent"
- Abstractions must be meaningful
- Prefer certainty, single source of truth - e.g. don't introduce "optional" unless absolutely necessary
- Structure code and files nicely, avoid fragmented or bloated files — prefer 200 LOC ~ 500 LOC for each
- Use suitable 3rd-party libraries instead of self-implementing to reduce understanding burden

### Refactor and Simplification

- Continuously refactor and simplify the codebase to keep it clean and maintainable
- All historical burdens should be removed, e.g. backward compatibility, temporary hacks, old data migration, etc
- Any stale features or stale APIs should be cleaned up
- Proactively push local changes to remote repo when a refactor is completed
- Do not design complex resilience around long-lived database failures. Treat the database as the durable source of truth and fail clearly when required writes cannot be persisted
- Avoid over-engineering
- Avoid excessive guards
- Remove a-few-lines wrapper functions, like small getters/setters
- Remove meaningless nil checks

### How to Name Symbols

- Consider verb clarity, noun specificity, context
- Choose the name that needs the least explanation

### Other Rules

Multi-branch development:

- If your current work dir is main branch, you should create a new worktree when you develop a new feature or fix a bug,
  and merge back to main branch after the work is done.
  You should not switch work dir to another branch or work directly in main branch. This allows you to work
  simultaneously with other people. After you finish all works, squash and merge the working branch to local
  main branch to make your change visible (see rules below). Remember to clean up your worktree if it is created
  by yourself.
- Use squash to merge these working branches to keep the main branch history clean.

If you are working in a worktree, here are rules to merge work back to local main branch:

- Principle: never resolve conflicts in main branch. Any possible conflict operations like merge, rebase, cherry-pick must be done in a temporary branch.
- The only allowed operation on main branch is fast-forward merge.
- To merge a feature branch locally, create a temporary integration worktree and branch from current `main`.
- Apply the feature branch in that integration worktree, usually with `git merge --squash`.
- Resolve conflicts and run tests only in the integration worktree.
- If remote `main` moved while you were working, redo the integration from the latest `origin/main`, still outside `main`.
- After the integration branch has one clean final commit, update `main` with `git merge --ff-only`.
- If integration fails or `ff-only` fails, delete the temporary integration worktree/branch and retry from latest `main`.
- Clean up integration branches when merge is done or not needed anymore.

If you are currently in main branch:

- This means you are currently working together with other people, and your directory is shared. NEVER switch to another branch unless user requests.

Git:

- Any built or generated artifacts should not be committed to git
- Deployer states, local dev VM info, or any other environment-specific info should not be committed to git, git is public and shared by all

## Tests

All features and journeys listed in `docs/spec.md` _must_ be covered by e2e tests, while other specs
(in `docs/ssot/<domain>/spec.md`) _should_ be covered by e2e tests if applicable.

### Rules

- E2E tests must test against behavior and user journeys in spec, instead of internal or implementation details
- When a change spans packaging, wrappers, docs, UI hints, or deployed runtime images,
  the verification plan must list each boundary explicitly. If any boundary cannot be
  exercised in the current turn, report it as an unverified gap and do not describe the
  work as fully end-to-end covered.
- Test cases must be simple, expressive, effective, and non-redundant
- Use simple and expanded test assertions over dynamic ones (even if it is not DRY)
- Always run e2e tests to test against real environment, make sure it works before finishing your work
- All tests must be portable and runnable in any Linux machine, e.g. in GitHub Action, instead of rely on something that only dev vm or local host provides
  Environment setup is necessary and acceptable, should be defined in GitHub Action workflow as SSOT
- GPU related tests or benchmarks may need to run on a dev VM (which should be a g4dn.xlarge instance), if local host does not have GPU

**Test efficiency is critical:**

- E2E test case should finish ideally within 10 seconds
- UI E2E tests should finish within 30 seconds
- Whole e2e test process should finish within 5 minutes
- Slow e2e tests should be proactively refactored, simplified, enhanced, or even removed
- Do not blindly split tests to fulfill time requirement, but rather think how to make it efficient
- Stale, duplicated or redundant test cases should be proactively removed or merged

### Dev VM

- See docs/local_dev/dev_vm.md for the current dev vm for this branch (and update it accordingly)
- Never access any dev vm not belonging to current branch, even if name looks similar
- If this file is missing, bootstrap a dev vm by yourself using AWS CLI and follow requirements below
- ALWAYS stop dev_vm when you finished your work, and remove dev_vm if worktree is deleted or branch is merged to main

Dev VM requirement:

- g4dn.xlarge + Ubuntu 24.04 + 100GB gp3
- Name it as lut-dev-{branch_name}
- Record necessary connection info (like IP) in docs/local_dev/dev_vm.md
- VM ssh key pairs should be generated and stored locally in docs/local_dev/id
- MUST change SSH port to use 2222 instead of 22. Allow 0.0.0.0 inbound access to use this port in security group
- See docs/local_dev/ref.md for some known steps of setup up a dev vm in a reproducible way

### Web UI E2E Tests (Playwright)

- Web UI e2e tests must be behavior-driven, simple, expressive and layout / DOM independent:
  add labels or attributes to UI elements to drive these tests.

## Backward Compatibility

- No need for any backward compatibility, all changes can be breaking changes, including public APIs,
  schema changes, etc. Code tidy is always the top priority.

## Requirements

### CLI

- Support `--output text|json` and `--json` as a convenience alias for `--output json` (text is default)
- Support `--color auto|always|never` (with `auto` as default) to control ANSI color in text output
- JSON output never use ANSI color
- Text output is optimized for _users_ to _read_ in terminal, not shell parsing. Always use readable,
  concise, clear and helpful messages in text output, instead of throwing IDs or raw data.
- Public CLI surfaces must expose product concepts only.

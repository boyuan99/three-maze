# Architecture decision records

These records fix the design choices that three-maze v1.0 is built on. Each one states what was decided, the options that were weighed, what the decision costs, and the tests or rig measurements that show it still holds.

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-player-mover.md) | Move the player per device sample with a hover kinematic character controller on compiler-partitioned colliders | Accepted; amended 2026-10-09 | 2026-10-08 |
| [0002](0002-task-engine-location.md) | Interpret declarative tasks in the motion worker; the Python rig runtime serves devices, supervises and hosts code tasks | Accepted; amended 2026-10-09 | 2026-10-08 |
| [0003](0003-render-worker-priority.md) | OffscreenCanvas rendering is P1 behind a week-6 promotion gate; everything that protects data is P0 | Accepted; amended 2026-10-09 | 2026-10-08 |
| [0004](0004-dependency-versions.md) | Pin exactly only the dependencies that change experimental behaviour; update everything through monthly, tested pull requests | Accepted; amended 2026-10-09 | 2026-10-08 |

## Statuses

- **Proposed**: written and reviewed, waiting for the project owner's decision. Not binding yet.
- **Accepted**: binding. Code, tests and the roadmap follow it. It may carry dated amendments that leave its decision in force (see [Amending a record](#amending-a-record)).
- **Superseded by ADR-NNNN**: replaced by a later record, kept for the history.
- **Rejected**: considered and not adopted, kept so the question is not reopened without new evidence.

## Adding a record

1. Use the next free number and a file name that names the topic, for example `0004-scene-schema-versioning.md`. The title states the decision itself.
2. Keep the section layout of the existing records: Context, Decision drivers, Considered options, Decision, Consequences, Validation, When to revisit, Evidence.
3. Cite code as `path:line` at a named commit, and give every number a source.
4. Never rewrite the decision of an accepted record, that is, the option it chose. Write a new record that supersedes it, and update the status line of both. Smaller changes that keep the decision are amendments (next section).

The prototypes and raw measurements behind 0001-0003 come from the 2026-10 design review and live outside the repository. The tests listed under each record's Validation bring the relevant cases into the repository.

## Amending a record

An accepted record can be amended without a new record when the project owner changes something that leaves the chosen option in force: the scope of a follow-up, a validation plan, a responsibility moved outside three-maze, or a pointer to evidence that turned out to be wrong. Anything that changes which option was chosen needs a superseding record (rule 4 above).

1. Change only the affected words, and mark the place with "(amended YYYY-MM-DD)".
2. Add a note headed **Amendment YYYY-MM-DD** at the end of the same section. It quotes the words it replaces, if any, word for word, and says what replaces them, why, and who decided. The replaced words then appear only in that note.
3. Add the date to the record's status line ("Accepted (date); amended date") and to the Status column of the index above.
4. Never edit an earlier amendment note. A later change gets its own note.

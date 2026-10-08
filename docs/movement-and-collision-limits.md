# Movement and collision limits

This page lists the limits on how the animal's avatar moves through a scene, and why they exist. Read it before building a scene. The decision record behind it, with the measurements, is [ADR-0001](adr/0001-player-mover.md).

Lengths are scene units (1 unit = 1 cm). The values assume the default eye height of 3.7; see [What you can change](#what-you-can-change).

## Why there are limits at all

The avatar is moved **kinematically**, not by simulated forces. Each sample from the ball sensor moves it by exactly the measured displacement, so movement in the virtual world equals movement on the ball (a gain of exactly 1). The physics engine, Rapier, is used only for geometry: it stops the avatar from passing through anything and slides it along whatever blocks it. The avatar has no mass, no weight and no friction.

So nothing in the physics decides whether a slope can be climbed or how high a step can be. Those are rules, and three-maze states them explicitly. A force-based model is not an alternative. The ball measures how far the animal ran, not how hard it pushed, so mass, push force and friction would be invented parameters, and the avatar would no longer move exactly as the ball did.

### This is how game engines do it

Character controllers in game engines work the same way: they are moved by code rather than forces, and they handle slopes, steps and surface contact with explicit limits.

| Engine | How its character controller is described | Limits it uses |
|---|---|---|
| Unity `CharacterController` | "not affected by forces and will only move when you call the Move function" | `slopeLimit`, `stepOffset`, `skinWidth` |
| Unreal Engine Character Movement Component | a character "will not be able to climb" a surface steeper than the walkable angle | Walkable Floor Angle (default about 45°) |
| Godot `CharacterBody3D` | "not affected by physics at all" | `floor_max_angle` (default 45°), `floor_snap_length` |
| Rapier character controller (used here) | kinematic bodies are "completely immune to forces or impulses (like gravity, contacts, joints)" | offset (skin), max slope climb angle, min slope slide angle, autostep, snap-to-ground |

Sources: [Unity](https://docs.unity3d.com/ScriptReference/CharacterController.html), [Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/walkable-slope-in-unreal-engine), [Godot](https://docs.godotengine.org/en/stable/classes/class_characterbody3d.html), [Rapier](https://rapier.rs/docs/user_guides/javascript/character_controller/) (checked 2026-10-08).

### Where three-maze is stricter than a game

A game tolerates small errors: a character a fraction of a millimetre inside a wall, an occasional missed contact, a slight camera bob over floor seams. An experiment cannot, because it needs:

- the avatar never inside or through a wall, and the camera never inside an object;
- a camera height that does not change while the animal runs on flat ground;
- the same trajectory for the same sensor data, at any frame rate or sensor rate.

three-maze therefore adds its own rules on top of Rapier's controller (about 70 lines in the mover, plus checks in the scene compiler), and an automated test suite that must pass before any change to the mover, the compiler or the Rapier version is merged.

The pinned Rapier version, 0.14.0, ignores the controller's own climb limit for horizontal pushes, and later versions apply it only to faces that point upward. The slope limit below is therefore enforced by three-maze's wall rule on every version.

## The limits

| Limit | Value | Why | Enforced by |
|---|---|---|---|
| Walkable slopes | up to 28° | The avatar's flat-bottomed body meets a small step where a ramp ends at a platform (0.5 × tan of the slope: 0.27 at 28°, 0.29 at 30°). At 30° that step is too high, and the avatar could not get off the ramp. | Scene check: a walkable ramp steeper than 28° is an error |
| Steep and overhanging faces | steeper than 30°, faces leaning over the avatar, sides of balls and cones | They act as walls: the avatar slides along them horizontally and never climbs them. Faces between 28° and 30° are rejected by the scene check above. | Mover (wall rule) |
| Steps | climbed up to 0.28; 0.29 and higher block | The avatar floats 0.3 above the floor so the camera stays steady; a downward probe lifts it onto lower steps. | Mover |
| Headroom | cannot pass under anything lower than eye height + 0.47 (4.17) | The collision body reaches 0.45 above the eye, so the camera can never enter an object. | Mover |
| Ramp sides | an invisible rail, 0.2 thick, along each open side of a walkable ramp | The avatar cannot step onto a ramp from its side; without rails it got stuck there. Ramps are entered and left only at their ends. | Scene compiler (added automatically) |
| Long walls | split into pieces of at most 40 units | Rapier's collision sweeps lose precision along long colliders; unsplit walls let the avatar slip in. | Scene compiler (automatic, invisible) |
| Convex shapes | at most 20 units across; cones built as polygon hulls | Larger hulls and Rapier's cone shape occasionally miss contacts. | Scene compiler (automatic) |
| Gap to surfaces | 0.02 | The controller keeps this "skin" between the avatar and every surface; rare contacts can end inside it, never deeper. | Mover |
| Sliding along walls | sideways wobble at most 0.03 along walls, 0.055 along inclined faces | A side effect of the controller's sliding, kept small by short sub-steps. | Mover; checked by the test suite |
| Falls | gravity −981 units/s²; the avatar lands only on walkable floors | Set `fall: "none"` in a scene to turn ledges into walls instead. | Mover |
| Zones (trial end, reward areas) | detected at a point on the avatar's axis, 1.15 above its feet | This matches how v0.3 detected the trial end. A zone thinner than one sample's movement (7.05 at 141 units/s and 20 samples/s) can be skipped, so the scene check warns about it. | Mover; scene check (warning) |
| Objects just beyond a ledge | warning if a vertical face stands 0.52-1.04 beyond a ledge | An avatar walking off the ledge there can hang on the edge. This is a known open issue. | Scene check (warning) |

## What you can change

- **Eye height** is set per rig in the rig file and recorded in every session. Headroom follows it (eye height + 0.47). Changing it changes the compiled collision body, so rerun the test suite.
- **Falls** are set per scene: `fall: "gravity"` or `fall: "none"`.
- **Steeper walkable slopes, higher steps, another body size or skin** are possible, but each one changes how the others behave. For example, 45° ramps need steps of about 0.5 to be climbable, and then obstacles lower than 0.5 are stepped over too. Each change needs the test suite rerun, and is recorded by a new decision record that supersedes ADR-0001.
- **"Uphill is harder"** (for example a lower gain on slopes) is not produced by the physics. If an experiment needs it, define it explicitly as a task rule, so that its parameters are chosen and reported.

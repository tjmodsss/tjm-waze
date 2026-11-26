# Changelog

## Unreleased

## 0.8.14

A host from layers sent with `hide` and `shown` 0 hides the hosted picture
while its target is on screen with a layer of the app drawn there, rather
than putting it back on its own slot under the app's layers: a cluster
theme on a page without the map widget then has the map shown nowhere,
and Maps on cluster sends no frames for it. Any app's shown host of the
same picture wins over it, on any target. It goes back to its own slot, as
without `hide`, when that target leaves the screen, the app's layers there
all hide, or the host ends. The hello's `host_hide` 1 says the service
takes it.

A video layer's `fresh_ms`: when its target is written again after it was
not, a frame that came before waits up to that long for a newer one, so a
map shown again is drawn with its newest picture first; the target's
other layers are written meanwhile. The hello's
`fresh_ms` 1 says the service takes it.

## 0.8.13

The service runs in the head unit's slice for standard services, level
with the HMI.

## 0.8.12

`--skip` shows a scene file's animation sequence at its end on iDrive 7: at
once in an animation system without a clock of its own, also when nothing
plays in it, and within 250 ms in a real-time one (its last 250 ms play; one
already in its last 250 ms, or ended, is left as it is).

## 0.8.11

Text layers: an app sends a font once (an `r8` atlas and its glyph table)
and then only its strings; the service lays each line out (advances,
kerning, alignment, UTF-8) and draws each glyph as two triangles, so a
line holds up to 256 glyphs (64 by default) instead of 14, a change sends
the string alone, and a frame samples the atlas once for each pixel a
glyph covers. Fonts may be distance fields, sharp at any size. The text
helpers of both clients use them; the hello's `text` 1 says the service
takes them.

## 0.8.10

A scene file's layers can have a band of their own above the file: the
`scene` field `over_order` draws the `overlay` and `alert` layers in passes
from that render order up, while `ambient` and `content` layers stay at
`layers_order`. A file can then draw its own artwork between hosted content
and an overlay. Without the field nothing changes; the hello's `over_order` 1
says the service takes it.

## 0.8.9

On iDrive 7, the service keeps seeing which of its scenes the cluster draws
while the car's DLT logging is off, so a map the cluster stops drawing at a
route's start is asked for again within about 2 seconds instead of staying
black.

A scene file's own animations can be played: the edit line `--play NAME`
starts the animation sequence `NAME` the file was saved with and `--skip
NAME` shows its end at once. In an animation system without a clock of its
own, the service sets its time once a tick, so the play never depends on the
display's clock. These lines are applied once and never kept; the hello's
`scene_anim` 1 says the display can play them.

## 0.8.8

A video layer's frames go to the service through memory both share instead
of through its socket, which takes less CPU for each frame. Clients and
services without it keep sending and taking whole frames on the socket.

With nothing shown, requested or due, the service wakes less often, and on
iDrive 8 it dispatches the cluster's events less often while it offers
nothing. The status file is written only when its text changes.

## 0.8.7

On iDrive 7, a cluster app's finished animations no longer stay in memory
after its session ends: they used to pile up across sessions, a few hundred
KB each, until a later app animated enough to replace them. Once the cluster
has nothing of an app's to show, the service also gives the memory it freed
back to the system, about 1.5 MB after a session.

## 0.8.6

Mesh parts can draw instances on iDrive 7 as shipped: the cluster draws
GLSL ES 3.00 and instanced draws. `instancing = 0` in `cluster-render.conf`
turns them off. On iDrive 8 they stay off unless `id8_instancing = 1`.

## 0.8.5

A text helper for both client libraries: an app sends a font once (from
glyph bitmaps, a monospace grid or a BMFont) and draws strings from it in
effect layers, laid out with the font's advances and kerning, each change
of string under 700 bytes.

Shared values: an app's float or vector that uniforms of several of its
layers and mesh parts follow, set or animated once for all of them, so a
glow, a colour or a level drawn in many places stays in step.

Cube maps: an asset of six square faces that effect layers and mesh parts
sample by direction, for reflections and environment lighting, sent once.

A mesh part can draw lines, a line loop, points or a triangle strip as well
as triangles, and draw its geometry up to 256 times at once (instances),
for gauge ticks, star fields or rows of identical shapes sent once. What
the mesh layers on a target draw is bounded: a part's indices times its
instances, a layer's parts together and every mesh layer on the target.
Effect layers and mesh parts take GLSL ES 3.00 shaders.

Animations can be eased (`ease_in`, `ease_out`, `ease_in_out`) or follow a
smooth curve through their keys, played by the cluster with nothing sent
per frame. A mesh part can follow another part or a pivot that draws
nothing, so one animation moves everything attached to it. On iDrive 7,
replacing or stopping an animation (a needle sent a new value) no longer
makes every animation on the cluster again each time: a replacement sends
its own keys, and only once the replaced and stopped ones' keys outnumber
the live ones' are the live ones made again, a few at a time. Animation keys
go within a share of the upload cap of their own, split between the
targets, so animations and writes never wait on each other, and together
stay within the cap.

## 0.8.4

The cluster map no longer keeps disappearing about 2 seconds after it shows,
which could go on for minutes after a head-unit restart with a cluster theme
installed. The service no longer takes the map down as not drawn while the
car's logging has RAMSES's messages turned off, since it cannot see then
whether the cluster draws it.

The C++ client library sends every repeated map frame to a service without
repeats, also one that comes while the frame before is still being sent;
it used to drop it.

## 0.8.3

Canvases: an app's effect and mesh layers can draw into an off-screen
picture of its own, which its layers on screen then show like an asset.
A canvas can have its own depth and stencil buffer, for masks and depth
tests that never touch the display's, and can be drawn once and kept until
something it shows or samples changes. A canvas drawn every frame is
skipped while nothing shown samples it. The client libraries send canvases
only to a service that takes them.

## 0.8.2

An app that draws the cluster with layers only, such as a cluster theme,
can show another app's picture (Waze's map) inside it with no scene file:
`host` with `into`. The picture is drawn under the app's layers, and goes
back to its own place when the app hides its layers, ends the host
(`unhost`) or exits, or the panel is taken. Of several such apps the one
drawn highest over the picture wins, and an app showing a scene file that
hosts the picture wins over them; the `hosting` event tells each app why it
waits.

## 0.8.1

Effect layers and mesh parts choose how they blend (presets such as
`premultiplied`, `max` and `subtract`, or their own factors and
operations) and which colour channels they write, and a part its depth
test. Assets can be sampled with mipmaps (the service makes the levels of
`rgba8` and `r8` assets; a compressed one brings its own), mirrored, with
each axis wrapped its own way and anisotropically. A shader is at most
64 KB.

## 0.8.0

A layer can ask for upload bandwidth while it is shown (`others_fps`): the
other apps' videos are then written at most that many times a second, 15
at the least, until the layer is hidden or goes or its app exits. The apps
held are told (`fps_cap`).

## 0.7.0

A layer can ask for its target's scene to stay loaded on the cluster while
nothing shows it, so the target appears without loading again when a layer
wants it (`preload`).


# Changelog

## Unreleased

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


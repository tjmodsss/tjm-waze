<!-- SPDX-License-Identifier: MPL-2.0
     Copyright (C) 2026 Robert Nisipeanu -->

# cluster-render protocol, version 1

A client connects to the service's stream socket
(`/dev/shm/cluster-render/render.sock`, group `tm_oap_app`). Messages go
both ways, each:

```
u32 length (little-endian: the bytes after it) | u8 type | body
```

| Type | Body |
|---|---|
| `J` (0x4A) | a flat JSON object: string and number values (true/false count as 1/0); in a string, a `\u` escape of a high surrogate and the low one after it are one character, and a surrogate alone makes the message malformed |
| `F` (0x46) | `u32 ref, u64 frame id, u16 rect count, rect count x {u16 x, y, w, h}, pixels` (little-endian) |
| `M` (0x4D) | a mesh part's geometry ([below](#mesh-geometry-m)) |

A message is at most 5,529,664 bytes (a whole 1920x720 RGBA image). A
vertex or fragment shader is at most 65,536 bytes (past it, `a shader is
at most 65536 bytes`): shaders are compiled in the render loop, and one
that does not compile is refused with an `error` event before anything
reaches the display. The C++
client is `include/cluster_render/client.h`, the Node 8 client
`js/cluster_render_client.js`; both reconnect by themselves and make their
assets and layers again, with their pixels, uniforms, parts and geometry,
binds and animations.

## Client to service

Every JSON message has `op`. A client names its layers, scenes and assets
with its own `ref` (a positive number, unique within its connection across
all three); they go when the connection does, the layers before the assets. A field the
service does not know is ignored, so a client may send one an older service
lacks.

| op | Fields |
|---|---|
| `hello` | `app` (a name for the logs), `proto` 1 |
| `layer` | `ref`, `target`, `kind` (`video`, `image`, `effect`, `mesh`, `text`), the layer fields, and the kind's fields |
| `asset` | `ref`, `target`, `format` (`rgba8` default, `r8`, `etc2rgba`, `etc2rgb`: below), `w`, `h` (1-2048, within one frame message), `sampling` (`nearest` default, `bilinear`; with mipmaps `nearest_mips`, `bilinear_mips`, `trilinear`, and `min_linear_mag_nearest`, `min_nearest_mag_linear`: [below](#mipmaps-and-samplers)), `wrap` (`clamp` default, `repeat`, `mirror`), `wrap_u`, `wrap_v` (each axis in place of `wrap`), `anisotropy` (1 default, to 16), `cube` (1: a [cube map](#cube-maps)) |
| `set` | `ref` and any layer field; for a mesh layer also its camera and projection fields (not `projection` itself) |
| `uniform` | `ref`, `name`, `v`, optional `type`, `part` ([below](#uniforms)); effect layers and mesh parts |
| `canvas` | `ref`, `target`, `w`, `h` (1-2048), `depth`, `clear`, `once`, `sampling`, `wrap`, `wrap_u`, `wrap_v`, `anisotropy` ([below](#canvases)) |
| `bind` | `ref` (an effect or mesh layer), `part` (a mesh layer's), `sampler` (the shader's `sampler2D`), `asset` (an asset's or a canvas's ref on the same target); binds again when sent again |
| `font` | `ref`, `asset`, `line`, `glyphs`, `kerning`, `sdf` ([below](#text)); to a service whose hello has `text` 1 |
| `text` | `ref` (a text layer), any of `text`, `align`, `spacing`, `size`, `color` ([below](#text)) |
| `value` | `ref`, `target`, `type` (`float` default, `vec2`, `vec3`, `vec4`), `v` ([below](#shared-values)); sent again with its ref, `v` alone: set |
| `link` | `ref` (an effect or mesh layer), `part` (a mesh layer's), `name` (the shader's uniform), `value` (a value's ref on the same target; 0: unlinked) ([below](#shared-values)) |
| `part` | `ref` (a mesh layer), `part` (1 or more), `vs`, `fs`, `depth` (1 default: tested less-or-equal and written; 0), `cull` (`back` default, `front`, `none`), `blend` (`alpha` default, `add`, `none`), and the rest of its render state ([below](#render-state)); or `node` 1 and no shaders: a pivot ([below](#part-hierarchies)); `parent` (a part made before it, [below](#part-hierarchies)); `draw` and `instances` ([below](#draw-modes-and-instances)) |
| `transform` | `ref`, `part`, any of `tx`, `ty`, `tz`, `rx`, `ry`, `rz` (degrees, right-handed), `sx`, `sy`, `sz` |
| `animate` | `ref`, `part`, `anim`, `property`, `name`, `keys`, `loop`, `interp` ([below](#animations)); `ref` a value's: `property` `value` or none, no `part` or `name` |
| `stop` | `ref`, `anim` |
| `scene` | `ref`, `target`, `file`, `res`, `sha256`, `contend`, `layers`, `layers_order`, `over_order` ([below](#scene-files)); sent again with its ref, another file in place |
| `edit` | `ref` (a scene), `lines` ([below](#scene-edits)) |
| `host` | `ref` (a scene with `layers` 1) or `into` (a target this client's layers are on, [below](#hosting-from-layers)), `target`, `x`, `y`, `w`, `h`, `src_x`, `src_y`, `src_w`, `src_h`, `shown`; optional `edge_top`, `edge_bottom`, `edge_fade`, `edge_dim`, `edge_blur` ([below](#hosting-another-target)) |
| `unhost` | `ref` or `into`, `target`: that host of `target` ends; to a service whose hello has `host_layers` 1 |
| `drop` | `ref`: a layer, a scene, an asset no layer samples and no font is over (else refused: `asset in use`), a font no text layer draws from (else refused: `font in use`), a canvas nothing draws in or samples (else refused: `canvas in use`), or a value (its links undone) |
| `repeat` | `ref` (a video layer): a frame whose atlas is the layer's last frame's, byte for byte, in place of that frame; to a service whose hello has `repeat` 1 |
| `shm` | `ref` (a video layer), `slots` (1-4), with a descriptor passed on the message (SCM_RIGHTS): the layer's [shared frame buffer](#shared-frames); answered by a `shm` event; to a service whose hello has `shm_frames` 1 |
| `slot` | `ref`, `slot`: the frame in that slot of the layer's shared buffer is its next frame, as an `F` frame would be |
| `status` | — (answered by a `status` event) |

A client has at most 64 layers and all clients together 96 (past either, a
layer is refused with `too many layers`); a client has at most 16 assets,
all clients together 32 (past either: `too many assets`).

Video layers: all clients together have at most 8 (past it: `too many
video layers`), each within the service's 16 MB of pixel memory (past it:
`the service's pixel memory is full`). The display holds the buffers of at
most 2 videos. While that holds every video, each video has buffers of its
own. Past it, the videos on one target drawn unturned (`rotate` 0, `sx` and
`sy` 1), at their frame's size (`w` x `h` = `vw` x `vh`) and at even `x`
and `y` share one: the service composes them into one video on the head
unit, on as few targets as it takes. A turned, scaled or odd-placed video
always takes one of its own. A `layer` or a `set` that would need a third
is refused with `too many video buffers on the display`, and one whose
target's videos would have to share across more than 1920x720 with `the
target's videos together span more than 1920x720`. Videos that share keep
their place in the stack, rect and opacity. During their target's fade in
or out, overlapping videos are drawn as one picture faded together, not
each faded on its own; outside fades they look as drawn on their own,
unless another layer is between two overlapping translucent ones in the
stack. They are written as
one video: while any of them moves faster than the upload budget covers,
all of them go as packed 4x4 blocks. A shared video moved or shown again
appears at its new place with the write that puts its pixels there, never
before.
A target's videos starting or stopping sharing rewrites its video whole, as
does the shared video being made again: at most once a second for the
videos' rectangle growing past it (till then what lies outside is cut),
and smaller once their rectangle has stayed smaller for 3 s. A `set` that
makes a video start or stop sharing (an odd `x`, a turn) takes effect at
most once a second on its target; till then a sharing video is drawn
unturned, at its frame's size and at the even `x` and `y` at or left of and
above its own. Such a `set` is refused at once when the videos would not
fit once it takes effect.

Layer fields (all optional):

| Field | Default | Meaning |
|---|---|---|
| `canvas` | — | effect and mesh layers: the client's canvas (its ref) the layer draws in, set when it is made ([below](#canvases)); its rect then in the canvas's pixels, its `class` and `z` its order there |
| `class` | `content` | `ambient`, `content`, `overlay` or `alert`: the stack's order, bottom to top |
| `z` | 0 | order within the class (-1000 to 1000); the newer layer is on top on a tie |
| `x`, `y`, `w`, `h` | the whole target | where the layer is drawn, in the target's pixels from its top-left |
| `visible` | 1 | 0 hides it; a target no visible layer wants is released after its linger (with a `preload` layer: taken off screen and kept loaded) |
| `exclusive` | 0 | 1 hides every layer below it while it is drawn, once its first write has gone |
| `prewarm` | 0 | 1 asks for the slot before the layer's first content |
| `preload` | 0 | 1, visible or not: while any layer on the target has it, the display keeps the target's scene loaded without showing it (`loading`, then `loaded`), so a layer that wants the target later is shown with no load (README.md "Arbitration"). No effect where the display cannot keep a scene loaded unshown (iDrive 8): there the target never reports `loading` or `loaded` |
| `contend` | 0 | 1 retries the slot after the stock HMI takes it (2, 5, 10, 20, then every 30 s), and on a target that takes over from the stock HMI (`map`), takes it from the stock content; 0 waits until it is free |
| `guide_hold` | 1 | on a target guide holds follow (`map`, iDrive 7): 0 keeps them released while this layer wants the target, so the stock HMI's turn box shows (README.md "Arbitration") |
| `yield` | 1 | on a target with yield slots (`hud`): 0 keeps the target shown over the stock HMI's pop-ups while this layer wants it (README.md "Arbitration") |
| `others_fps` | 0 | 15-60: bandwidth for this client ([below](#bandwidth-for-a-layer)); 1-14 count as 15; 0: no request. Send it only to a service whose hello has `others_fps` 1 (an older one ignores it) |
| `hosted` | empty | a producer's layer placed by a host of its target: that target's name (at most 32 characters), so a host from layers stacks it by its own layers ([below](#hosting-from-layers)); `""` clears it. A service whose hello has no `host_layers` 1 ignores it |
| `opacity` | 1 | 0-1, for video and image layers; drawn times the target's fade in and out |
| `rotate` | 0 | video, image and effect layers: degrees clockwise about the pivot |
| `sx`, `sy` | 1 | video, image and effect layers: scale about the pivot |
| `px`, `py` | the rect's centre | the pivot, in pixels from the rect's top-left; once set, kept until set again |

Kind fields:

| Kind | Field | Default | |
|---|---|---|---|
| video | `vw`, `vh` | 1088, 480 | the frame size; width a multiple of 4, height even, up to 1920x720 |
| | `fps` | 30 | updates a second at most (0: no clock) |
| | `level_bits` | 2 | low bits of each level rounded away (0-3) |
| | `dirty_threshold` | 8 | tiles differing by at most this many levels are not written (0-64) |
| | `settle_ms` | 1000 | such a tile is written after this long anyway (0: never) |
| | `pan_blocks` | 1 | fast motion as packed 4x4 blocks |
| | `always_packed` | 0 | optional; 1: every write as packed 4x4 blocks, never the exact atlas. Each update is planned as an exact one (`dirty_threshold`, `settle_ms`, the tiles), and only the blocks in its tiles that changed are written, in place; the whole packed buffer goes only with the layer's first write in a scene or after a failed one, and a still picture writes nothing. Needs `pan_blocks` 1 and `vh` a multiple of 4, else it is off. A target's shared video has it only when all of its videos do. Send it only to a service whose hello has `always_packed` 1 (a service without it ignores it and writes the layer exact); a layer without it is written exact |
| | `stall_ms` | 6000 | no frame for this long: the layer is stalled (not drawn) |
| image | `iw`, `ih` | the rect | the image size, up to 1920x720 |
| | `fps` | 30 | writes a second at most |
| | `sampling` | `nearest` | or `bilinear` (a rect of another size than the image) |
| effect | `fs` | — | the fragment shader, with `v_uv` (0,0 at the top-left): GLSL ES 1.00 (`varying vec2 v_uv`) with the service's `vs`, or the version of the client's `vs` |
| | `vs` | the service's (GLSL ES 1.00) | a vertex shader with `a_position` (vec2) and `uniform mat4 u_mvp`: GLSL ES 1.00, or 3.00 (`#version 300 es`, `in` and `out` for `attribute` and `varying`), as its `fs` |
| | `time_fps` | 0 | `u_time` (seconds since the layer was made) updated this often |
| | `time` | 0 | 1: `u_time` from the renderer's own clock, seconds from 0 to 3600 and again, nothing sent per frame (declare it `highp`); excludes `time_fps` |
| | `blend`, `blend_*`, `color_mask` | `alpha`, `rgba` | how its quad blends and which channels it writes ([below](#render-state)); a `set` changes them |
| text | `font`, `max`, `text`, `align`, `spacing`, `size`, `color` | | [below](#text) |
| mesh | `projection` | `perspective` | or `ortho`; set when the layer is made |
| | `fov` | 30 | perspective: the vertical field of view, degrees (1-179) |
| | `ortho_h` | 2 | ortho: the height seen, in scene units |
| | `near`, `far` | 0.1, 100 | the clip planes |
| | `cx`, `cy`, `cz` | 0, 0, 0 | the camera's position; it looks down its -z |
| | `crx`, `cry`, `crz` | 0, 0, 0 | the camera's rotation, degrees, right-handed |

A mesh layer is drawn in a render pass of its own over its rect, at its
place in the stack, with the rect's aspect; a rect reaching past the target
is cut, not squeezed. It is ready once a part has geometry. Its passes clear
depth, never colour: the layers below it show.

Frames (`F`):
- **video**: no rects, and the whole 4:2:0 atlas: Y (w x h), then U and V
  side by side (w/2 each) in h/2 rows; `w * h * 3/2` bytes. Each frame
  replaces the layer's frame not yet written. A `repeat` counts as a frame
  (it keeps the layer from stalling), with nothing to write; before the
  layer's first frame it does nothing.
- **image**: RGBA rows, straight alpha. With rects, each rect's rows packed
  one rect after another; with none, the whole image.
- **asset**: the same, RGBA or one byte a pixel (`r8`).
- **asset** `etc2rgba`, `etc2rgb`: no rects, and the whole texture once,
  `w` and `h` multiples of 4, blocks in rows top to bottom (sampled with
  mipmaps, each mip level after it, [below](#mipmaps-and-samplers)):
  - `etc2rgba`: ETC2 RGBA with EAC alpha (`GL_COMPRESSED_RGBA8_ETC2_EAC`),
    16 bytes a 4x4 block, each the alpha block then the colour block:
    `(w/4) * (h/4) * 16` bytes, a quarter of `rgba8`'s.
  - `etc2rgb`: opaque ETC2 RGB (`GL_COMPRESSED_RGB8_ETC2`), 8 bytes a 4x4
    block: `(w/4) * (h/4) * 8` bytes, an eighth of `rgba8`'s. Every pixel is
    drawn with alpha 1.

  A second frame is refused (`an etc2rgba asset is sent once`, or `etc2rgb`). Charged
  once to the pixel memory (no rectangle scratch). If the renderer refuses
  its texture, every layer sampling it is in `error` with `reason`
  `asset N: the renderer refused its WxH etc2rgba texture` (or `etc2rgb`).
  `tools/etc2_test/etc2_encode.py` encodes both.

An asset is not drawn and never makes its target wanted. The service keeps
its pixels, writes them whole into each new scene of its target and in place
as they change, before the layers, within the shared upload budget. A layer
that samples an asset is stalled until the asset has pixels, and waits while
the asset's buffer does not hold them whole.

### Shared frames

A video layer's frames can go through a buffer both sides map, in place of
the whole atlas on the socket (Linux only). The buffer is a memfd sealed
against shrinking (`F_SEAL_SHRINK`), of 64 bytes and then `slots` slots of
one whole atlas each; its first bytes are one 32-bit word a slot, 1 while
the slot holds a frame the service has not taken. The client sends `shm`
with the descriptor once a layer is made, and uses the buffer once the
service's `shm` event has `ok` 1. For a frame it picks a slot whose word is
0, sets the word to 1, writes the atlas and sends `slot`; the service copies
the frame out and sets the word to 0. With no slot free, or before `ok`, a
frame goes whole as an `F` frame. A `shm` for a layer that has one replaces
it; dropping the layer ends it.

### Choosing a pixel format

| Format | Bytes a pixel | Alpha | Changed after it is sent |
|---|---|---|---|
| `rgba8` (image layer or asset) | 4 | yes | yes, by rectangles |
| `r8` (asset) | 1 | no: one channel, read as `.r` (masks, glyphs) | yes, by rectangles |
| `etc2rgba` (asset) | 1 | yes | no: sent once |
| `etc2rgb` (asset) | 0.5 | no, opaque | no: sent once |
| video layer (4:2:0 atlas) | 1.5 | no | every frame, only the tiles that changed |

The cluster cannot change a compressed texture in place, on iDrive 7 or
iDrive 8: only uncompressed textures take updates. New pixels for an
`etc2rgba` or `etc2rgb` asset mean a new asset sent whole, which costs its
full size in upload.

- **Artwork sent once, then animated** by moving, scaling, fading or
  switching sprite-sheet frames: a compressed asset, preloaded
  ([Animating preloaded assets](#animating-preloaded-assets)).
- **Text:** a text layer ([below](#text)).
- **Pixels that change often** (drawn per frame, partial updates): `rgba8` or `r8`, updated by rectangle, or an effect shader that
  draws them.
- **Live video:** a video layer.

The trade-off is two limits all clients share: the service's 16 MB of pixel
memory (image layers and uncompressed assets count twice their size,
compressed assets once, a video layer about four times its 4:2:0 frame; mesh
geometry counts too) and the upload cap (5500 KB/s as shipped, lower while
the link struggles: the `budget` event). Compressed assets spare both;
uncompressed ones cost upload at each change.

### Shaders

GLSL ES 1.00, or GLSL ES 3.00 where a shader starts `#version 300 es` (the
two shaders of an effect or part the same version; `in` and `out` in place
of `attribute` and `varying`). The renderer fills these uniforms wherever a
shader declares them, so in every shader they are reserved for it and must
be mat4:
`u_mvp`, `u_mv`, `u_m`, `u_v`, `u_p` (model-view-projection, model-view,
model, view, projection) and `u_normal` (the inverse transpose of `u_mv`).
A part's vertex shader reads `vec3 a_position` (an `attribute`, or `in` in
GLSL ES 3.00) and any of `vec3 a_normal`, `vec2 a_texcoord`, `vec4
a_color`; its geometry must carry every attribute it reads.

### Uniforms

Without `type`, `v` is 1 to 4 numbers separated by spaces: a float, vec2,
vec3 or vec4. With `type` (`float`, `vec2`, `vec3`, `vec4`, `mat4`), `v` is
up to 1024 finite numbers, whole elements of the type: one value, or an
array uniform of that many elements (a mat4 is 16 numbers in GLSL's column
order). `part` names a mesh layer's part; an effect layer has none. A quad
or part holds at most 32 uniforms and 4096 numbers. A name the shader does
not have is dropped.

### Mesh geometry (`M`)

```
u32 ref | u32 part | u32 vertices | u32 indices | u8 mask |
f32 positions (xyz per vertex) |
[f32 normals (xyz)]    mask 1
[f32 texcoords (uv)]   mask 2
[f32 colors (rgba)]    mask 4
u16 indices (as the part's draw mode takes them)
```

All little-endian. 1 to 65535 vertices; 1 to 196605 indices, as many as
the part's draw mode takes (whole triangles by default), each less than the
vertex count; every value finite; the body at
most 4 MiB and exactly this long. Anything else is refused with an `error`
event (`op` `mesh`). The geometry becomes immutable resources in the
renderer: a part's geometry may be replaced, at most once a second, and its
bytes spend the shared upload budget.

### Animations

The renderer plays an animation by itself; nothing is sent per frame. `anim`
is the client's number for it (1 or more), unique within the layer: sending
it again replaces it where it is (a needle sent to a new value moves on from
there; several replacements before the next flush, only the newest is
made, the old one playing until then), `stop` ends it and its property goes
back to what the client set. A layer plays at most 16. An animation's keys
go to the renderer with the scene (about 8 bytes a key with one value) out
of a share of the upload cap of their own: an eighth of it, split evenly
between the targets, the rest pacing the layers' writes while an animation
waits for its keys (with none waiting, the writes have the whole cap, and
the share fills only while they have the rest), so animations and writes
never wait on each other, nor one target's animations on another's, and
together stay within the cap. A target's flush makes waiting animations while its share has
bytes left, the connections with animations waiting taking turns, and those
left start at its next flushes; a flush goes past the share by less than
one animation (at most 20,480 bytes, 1,024 keys of four values), which its
next refills repay. Nothing is refused for the budget: an animation sent
again after a reconnect, or one a new scene makes again, waits its turn the
same way. Replacing one sends its keys and stopping or dropping one sends
none, except on iDrive 7: there the ones replaced, stopped or dropped stay
in the renderer's animation system, and once their keys outnumber the live
ones' (and 4,096), every animation still playing on the target is made
again in a new system, a few a flush within the target's share, each going
on from where it was; once none plays on the target any more, the system
goes with every one it kept at the next flush. A replacement that plays elsewhere gives the old part
or uniform back its own value once it is made.

| Field | |
|---|---|
| `part` | a mesh layer's part; absent: the layer's quad, or a mesh layer's camera |
| `property` | `rotate`, `translate`, `scale` or `uniform` |
| `name` | the uniform's name (`property` `uniform`) |
| `keys` | `t:v[,v,v,v] t:v ...`: `t` in ms from the start, ascending; every key the same number of values; at most 256 keys |
| `loop` | 1: from the first key again after the last; 0 (default): holds the last |
| `interp` | `linear` (default) or `step`; to a service whose hello has `curves` 1, `ease_in`, `ease_out`, `ease_in_out` (each segment between two keys eased by a cubic: starting slow, ending slow, or both) or `smooth` (a Catmull-Rom curve through every key, without corners where segments meet) |

Values a key takes:

| On | `rotate` | `translate` | `scale` | `uniform` |
|---|---|---|---|---|
| an image or effect layer | 1: degrees clockwise about the pivot | 3: pixels right, down, out from its place | 3 | 1, 3 or 4: float, vec3, vec4 |
| a mesh part | 3: degrees about x, y, z, right-handed | 3 | 3 | 1, 3 or 4 |
| a mesh layer's camera | 3 | 3 | — | — |

Animations are kept, and start again when a scene is published again.

An eased curve is played by the renderer as linear keys the service
samples from it: each segment in up to 16 steps, at least a millisecond
apart, at most 1,024 keys in all. It plays the same on RAMSES 19 and RAMSES
27 (which has no curved splines), and costs no more to send than its
keys. The service works the curve out in double; a curve that leaves the
range of a float (keys near ±3.4e38) is refused (`the curve leaves the
numbers a key holds`).

### Draw modes and instances

Send these only to a service whose hello has `draw` 1. A part's `draw` is
how its indices are drawn, the modes RAMSES 19 and RAMSES 27 share:
`triangles` (default; whole triangles), `triangle_strip` (3 or more),
`lines` (whole pairs), `line_loop` (2 or more) or `points` (1 or more; the
vertex shader sets `gl_PointSize`). Lines are a pixel wide. Geometry whose
index count does not fit its part's mode is refused (`the part's indices
are ...`). A part's `instances` (1-256, default 1) draws its geometry that
many times in one draw, `gl_InstanceID` telling them apart in a GLSL ES
3.00 vertex shader (`#version 300 es`, `in` and `out` in place of
`attribute` and `varying`). Both are set when the part is made.

Instances above 1 are taken only by a service whose hello has `instances`
1; otherwise the part is refused (`instances are off on this cluster`).
On iDrive 7 they are on as shipped: the cluster's renderer draws GLSL ES
3.00 and instanced draws. `instancing = 0` in `cluster-render.conf` turns
them off, and with them the GLSL ES 3.00 shader for distance-field
[text](#text). On iDrive 8 they are off as shipped (`id8_instancing = 0`):
whether its cluster draws them is not known, and if it could not, its
renderer would hold up the whole target's scene, every app's content on
it, until it gave up on the effect.

What a frame draws is bounded, in indices drawn (a part's indices times its
instances): a part at most 196,605 (65,535 triangles, as many as one part's
geometry holds without instances), a mesh layer's parts together 393,216,
and every mesh layer on a target, of every client, on screen and in
canvases, 786,432 (262,144 triangles). Geometry past one of them is refused
(`a part draws at most 196605 indices: ...`, `a mesh layer's parts draw at
most 393216 indices together`, `a target's mesh layers draw at most 786432
indices together`).

### Part hierarchies

Send these only to a service whose hello has `nodes` 1. A part sent with
`parent` (another part of the layer, made before it) follows it: its
transform and animations are relative to its parent's, so turning a parent
turns everything that follows it. A part sent with `node` 1 and no shaders
is a pivot: it draws nothing and takes no geometry (`a pivot draws
nothing`), and is transformed, animated and followed as a part; one sent
with `vs` or `fs` is refused (`a pivot (node 1) has no shaders`). A parent
is made first, so a part never follows itself or a part that follows it; a
part whose parent is not there is refused with nothing made (`a part's
parent is another part of the layer, made before it`). A part dropped, a
pivot or one that draws, leaves what followed it following the layer's
camera view, as if sent with no parent. Pivots and parents
work alike in a [canvas](#canvases). The parts of a layer are made again in
each new scene, each with its parent; the client libraries send parts again
after a reconnect in the order they were made.

### Text

Send these only to a service whose hello has `text` 1. A client sends a
font once: an `r8` asset of its glyphs and a table of where each glyph is
and how it advances. A text layer draws one line of a string from it: the
service lays the string out and draws each glyph as two triangles of its
own, sampling the atlas once a pixel, from vertex buffers its scene keeps.
A string change is one `text` message carrying the string.

- **A font** (`font`): `ref` (the client's own, as a layer's or an
  asset's), `asset` (an `r8` asset of the client's, up to 2048x2048),
  `line` (the line's height in atlas pixels, 1-2048), `glyphs`
  (`code:x,y,w,h,left,top,advance ...`: a Unicode scalar value, its box in
  the atlas, its offset from the pen and from the line's top, and its
  advance, in atlas pixels; at most 1024 glyphs, each once; offsets -2048 to
  2048, advances 0 to 2048), `kerning` (`first,second:amount ...`: pairs of
  glyphs the font has, -2048 to 2048, at most 4096), `sdf` (0 by default: the
  atlas holds coverage; 1-64: it holds a distance field, 0.5 on the edge,
  this many atlas pixels each side). Anything else is refused with nothing
  made (`a font's atlas is an r8 asset`, `glyph 65: its box is outside the
  atlas`, `glyph 65 comes twice`, `kerning 65,67: a glyph the font lacks`,
  ...). A client has at most 8 fonts; a font's table counts in the
  service's memory. `drop` drops one, refused while a text layer draws from
  it (`font in use`); its asset is refused while the font is there (`asset
  in use: a font draws from it`).
- **A text layer** (`layer` with `kind` `text`): `font` (a font whose asset
  is on the layer's target), `max` (the glyphs it holds, 1-256, 64 by
  default), and its `text` (UTF-8, at most 1024 bytes), `align` (`left` by
  default, `center`, `right`), `spacing` (pixels between characters, -1024
  to 1024), `size` (the line's height in the target's pixels; 0, the
  default: the layer's height) and `color` (`r g b a`, straight alpha 0-1,
  drawn premultiplied). A `text` message sets any of these but `font` and
  `max`; a `set` changes its layer fields. It is turned, scaled and stacked
  as an effect layer, and its `u_color` animated with `animate` (`property`
  `uniform`). It takes no `uniform`, `bind` or `link`, and draws on its
  target, not in a canvas. Text past 1024 bytes or not well-formed UTF-8
  (overlong, surrogates, past U+10FFFF, cut short) is refused (`text is
  at most 1024 bytes of UTF-8`, `text is not UTF-8`) and the layer keeps
  its string; in a `layer` message the layer is made with no string, and
  the string is refused with an `error` event of `op` `text`.
- **A glyph write the renderer refuses:** the layer is hidden and in
  `error` with the reason (`the renderer refused N glyphs`) until its
  string, its style or its target's scene changes; the target's other
  layers flush on.
- **Layout:** the font scaled to `size`; each glyph's top-left on whole
  pixels, so a font drawn at the size it was made maps each texel to a
  pixel; kerning and `spacing` between characters, none after the last;
  aligned in the rect by whole pixels; a character the font lacks advances
  by the font's space, or not at all; glyphs cut at the rect's edges, the
  atlas box with them; past `max` glyphs the rest are not drawn. Glyphs
  that overlap (kerning, a bearing) are drawn over each other.
- **Cost:** a string change sends its JSON message alone (a line of 64
  glyphs: about 100 bytes); the service writes 64 bytes a glyph into the
  scene, at most 30 times a second a layer, the newest string each time,
  within the upload budget. Each frame draws two triangles a glyph and
  samples the atlas once for each pixel a glyph covers. A layer's buffers
  (76 bytes a glyph of its `max`, twice) count in the service's memory.
- **Sharp at any size:** make the font at the size it is drawn, or send a
  distance field (`sdf`), whose edge stays about a pixel wide on screen at
  any size and scale. Where the cluster draws GLSL ES 3.00 (the hello's
  `instances` 1, set by `instancing` and `id8_instancing` in
  `cluster-render.conf`) the service draws it with a shader that takes the edge's
  width from screen-space derivatives, whatever the layer's turn, scale or
  animations; elsewhere from the layer's size and its largest scale (`sx`,
  `sy`, and the largest a `scale` animation of it reaches).

Both clients come with a helper that packs glyphs into an atlas and sends
it with its table (`js/cluster_render_text.js`; `include/cluster_render/text.h`,
in `libcluster_render_client.a`): from glyph bitmaps (any rasteriser the
app has, at build time or on the unit), a monospace grid image, or an
AngelCode BMFont (`.fnt` text and its page's pixels, R8 or the alpha of
RGBA; one page, glyphs not packed in channels, inside the page, no negative
`xadvance`). Its `set()` says whether the string fits (no more glyphs than
the layer holds, no wider than its rect); a string the service would
refuse is refused there, nothing sent, the last one kept. A helper's font
owns its atlas: dropping the font drops the atlas. An app that draws text
requires the `cluster-render` release that has it; a client holds its
fonts, their atlases and its text layers until a service's hello has
`text` 1, and never sends them to an older one.

```js
const { Font, Text } = require('./cluster_render_text.js');
const font = Font.fromBMFont(fntText, { pixels: pageAlpha, w: 512, h: 256 });
const fontRef = font.asset(cr, 'panel');
const speed = new Text(cr, font, fontRef, { target: 'panel', x: 1300, y: 300, w: 400, h: 96,
    align: 'right', color: [1, 1, 1, 1] });
speed.set('123 km/h');
```

### Animating preloaded assets

Artwork sent once as assets is animated with no more pixels sent: an effect
or mesh layer samples it, and a uniform, a `set` or an animation changes what
is drawn.

- **A sprite-sheet frame:** the shader samples a sub-rectangle of the asset
  named by a uniform. Each `uniform` picks another frame (a message of a few
  dozen bytes), or an `animate` with `interp` `step` plays the frames in
  the renderer with nothing sent per frame (up to 256 keys).
- **Move, scale, rotate:** `set` `x`, `y`, `sx`, `sy`, `rotate`, or
  `animate` `translate`, `scale`, `rotate`.
- **Fade:** a uniform the shader multiplies alpha by (`opacity` is for
  video and image layers), set or animated.
- **Shader-driven motion:** `time` 1 gives the shader the renderer's clock.
- **Meshes:** a part samples an asset through `bind` with `part`, with its
  geometry's `a_texcoord`; its uniforms, transforms and animations as above.

A 4x2 sheet of 128x128 frames in one 512x256 `etc2rgba` asset (131,072
bytes, sent once), played at 12 frames a second and turning:

```
{"op":"asset","ref":1,"target":"panel","format":"etc2rgba","w":512,"h":256}
F ref 1, no rects, the sheet's 131,072 bytes
{"op":"layer","ref":2,"target":"panel","kind":"effect","x":800,"y":300,"w":128,"h":128,
 "fs":"precision mediump float;uniform sampler2D u_sheet;uniform vec4 u_cell;uniform float u_alpha;varying vec2 v_uv;void main(){vec4 c=texture2D(u_sheet,u_cell.xy+v_uv*u_cell.zw);gl_FragColor=vec4(c.rgb,c.a*u_alpha);}"}
{"op":"bind","ref":2,"sampler":"u_sheet","asset":1}
{"op":"uniform","ref":2,"name":"u_alpha","v":"1"}
{"op":"animate","ref":2,"anim":1,"property":"uniform","name":"u_cell","interp":"step","loop":1,
 "keys":"0:0,0,0.25,0.5 83:0.25,0,0.25,0.5 167:0.5,0,0.25,0.5 250:0.75,0,0.25,0.5 333:0,0.5,0.25,0.5 417:0.25,0.5,0.25,0.5 500:0.5,0.5,0.25,0.5 583:0.75,0.5,0.25,0.5 667:0,0,0.25,0.5"}
{"op":"animate","ref":2,"anim":2,"property":"rotate","loop":1,"keys":"0:0 4000:360"}
```

`u_cell` is the frame's top-left and size in texture coordinates (x, y, w,
h). Keep frames on 4-pixel boundaries for the compressed formats, and with
`bilinear` sampling leave a pixel of gap between them.

### Render state

Send these only to a service whose hello has `render_state` 1 (an older
one ignores them, and takes only the `blend` values `alpha`, `add` and
`none` of a part). An effect layer takes the blend fields and
`color_mask`, when it is made and in a `set` (the fields sent change, the
others stay); a mesh part takes them all with its `part` message. On a
video, image or mesh layer's `set` they are ignored.

| Field | Default | |
|---|---|---|
| `blend` | `alpha` | a preset: `alpha` (over what is below at source alpha), `add` (added at source alpha), `none` (written over), `premultiplied` (a colour already multiplied by its alpha, over), `max`, `min` (each channel's larger or smaller), `subtract` (taken away at source alpha) |
| `blend_src`, `blend_dst` | the preset's | the colour's factors: `zero`, `one`, `src_alpha`, `one_minus_src_alpha`, `dst_alpha`, `one_minus_dst_alpha` |
| `blend_src_alpha`, `blend_dst_alpha` | the preset's | alpha's factors, the same names |
| `blend_op`, `blend_op_alpha` | the preset's | `add`, `subtract` (source minus destination), `reverse_subtract`, `min`, `max` |
| `color_mask` | `rgba` | the channels written: some of `r`, `g`, `b`, `a`, each once, or `none` |
| `depth_func` | `less_equal` | parts: `less`, `less_equal`, `equal`, `not_equal`, `greater`, `greater_equal`, `always`, `never`; with `depth` 1 |
| `depth_write` | 1 | parts: 0 tests depth without writing it; with `depth` 1 |
| `stencil_func` | `off` | only in a [canvas](#canvases) with `depth` 1, and to a service whose hello has `canvas` 1: `off`, `never`, `always`, `equal`, `not_equal`, `less`, `less_equal`, `greater`, `greater_equal` (the fragment's `stencil_ref` against the stencil, both under `stencil_mask`). The other stencil fields never turn the stencil on; a `set` without `stencil_func` keeps it |
| `stencil_ref`, `stencil_mask` | 0, 255 | 0-255 |
| `stencil_fail`, `stencil_depth_fail`, `stencil_pass` | `keep` | what the stencil becomes when the test fails, when it passes but depth fails, and when both pass: `keep`, `zero`, `replace` (by `stencil_ref`), `increment`, `increment_wrap`, `decrement`, `decrement_wrap`, `invert` |

A `blend_*` field changes the preset it is sent with (or the look the layer
has) into a custom one; with `blend` `none` it is refused. The factors are
the ones RAMSES 19 has: no colour or constant factors, on iDrive 7 and
iDrive 8 alike. A quad tests no depth and culls nothing; an effect layer's
`depth` and `cull` fields are ignored. Every value is checked before the
renderer sees it: a name outside these is refused with an `error` event
and nothing is made.

What a layer draws stays in its rect's place in the stack: a blend that
reads or clears the destination changes only the pixels its own quad or
part covers, as an opaque layer there would. A part's depth test sees only
its own layer's depth: each mesh layer's pass clears depth first.

Stencil fields on screen, or in a canvas without `depth`, are refused: the
display's stencil belongs to every scene it draws.

### Mipmaps and samplers

Send these only to a service whose hello has `samplers` 1 (an older one
refuses the new `sampling` and `wrap` values and ignores the rest).

An asset sampled with `nearest_mips`, `bilinear_mips` (bilinear within the
nearest level) or `trilinear` (between the two nearest) has mip levels: an
`rgba8` or `r8` asset every level down to 1x1, which the service makes
from its pixels (each pixel the mean of the four above it; RGBA weighted by
alpha, so transparent pixels lend no colour) and writes with them: whole
with the asset, and again in the rectangles a change touches, each level's
under it, within the upload budget. A compressed asset's levels come from
the client, after its picture in its one frame, down to the last level
whose sides are both multiples of 4 (a 64x32 `etc2rgba` asset: 64x32,
32x16, 16x8 and 8x4, 2,720 bytes in all; RAMSES 27 warns that a smaller
ETC2 level may fail to upload). Its frame is that chain or is refused
(`a whole asset is N bytes`). The levels count in the pixel memory (an
`rgba8` asset's about a third more).

`min_linear_mag_nearest` and `min_nearest_mag_linear` sample linear when
the asset is drawn smaller and nearest when larger, or the other way round,
from its picture alone. `mirror` repeats the asset mirrored. `anisotropy`
2-16 samples a surface seen at a slant sharper, as far as the display's GPU
goes (iDrive 7 and iDrive 8 not checked on a car).

### Cube maps

Send `cube` 1 only to a service whose hello has `cube` 1. An asset with
`cube` 1 is a cube map: `w` x `w` faces (`h` the same), any format, its
one frame the six faces one after another, +x, -x, +y, -y, +z, -z, each as
an asset of that format and size, rows top to bottom. A shader samples it
with `samplerCube` and `textureCube` (`texture` in GLSL ES 3.00), bound as
any asset. A cube map is bound to a `samplerCube`, and only a cube
map is: a `bind` of a cube map to a `sampler2D`, or of another asset or a
canvas to a `samplerCube`, is refused (`the shader's u_sky is a ...`), as
is one to a uniform the compiled effect has as no sampler (`the shader has
no sampler ...`). The kinds are the compiled effect's, as the display's
library reflects them; on iDrive 7, whose library reports one type for
both, a sampler's kind is taken from its declarations where they agree (a
type behind a define, or other kinds in other `#if` branches, leave it
unchecked). A layer whose sampler the display does not bind is in `error`,
never shown. Like a compressed asset it is sent whole and once (`a cube map
is sent whole, with no rects`, `a cube map is sent once`), has no mip
levels, and its six faces count once in the pixel memory and the upload
budget; the faces must fit one frame message (a 479x479 `rgba8` cube map,
or a 1,356x1,356 `etc2rgb` one, at most). To an older service, which
knows no `cube`, the asset is a plain one: its six-face frame is refused
(`a whole asset is ... bytes`) and the layers sampling it stay `stalled`,
nothing drawn. Check the hello's `cube` (`takes_cube()`, `cubeMaps`)
first.

### Shared values

Send these only to a service whose hello has `values` 1. A value is a
client's float, `vec2`, `vec3` or `vec4` on a target, made by `value` with
its first `v` (zeros when absent), which uniforms of the client's effect
layers and mesh parts there follow (`link`), on screen and in canvases.
One `value` with its ref and a new `v` sets it, and one `animate` of it
moves it, for every uniform that follows it at once: the display holds it
once (a RAMSES data object bound to each uniform), so they never drift
apart, whenever each was linked, and a change costs one value's bytes
however many follow it.

- **Links:** `link` makes the layer's uniform `name` (a mesh layer's
  part's, with `part`) follow `value`, sent again with another value to
  follow that one, with `value` 0 to follow none; a `value` that is not a
  ref is refused (`value is a value's ref, or 0 to unlink`). The uniform is
  checked when the link is sent, whether or not the target is in a scene,
  against the effect's uniforms as the display's library compiled it (one
  of a list, a struct's member as `u_lamp.k`, the `#if` branch taken): there
  (`the shader has no uniform ...`), plain, not an array (`... is an array:
  a value is linked to a plain uniform`), and of the value's type (`the
  shader's u_glow is a vec3, the value a float`); a pivot has none (`a
  pivot has no uniforms`). Where the display cannot describe a shader's
  uniforms, no link to it is taken (`the display cannot describe this
  shader's uniforms: no link to it`) and its uniforms keep their own
  values. A
  followed uniform's own `uniform` messages are kept, not drawn, and drawn
  again when it is unlinked. A uniform an animation of the layer plays is
  not linked (`an animation plays the uniform: stop it first`), nor is a
  linked uniform animated on its own (`the uniform follows a value`). A
  layer has at most 32 links. A canvas drawn once (`once`) draws again
  when a value one of its layers follows is set, animated or stopped.
- **Animation keys** are made within the target's upload budget, the
  clients taking turns, as a layer's are ([Animations](#animations)).
  Dropping a value that was animated makes no other animation again.
- **Animations:** `animate` with the value's ref, `anim`, `keys` of the
  value's width, `loop` and `interp` as a layer's, `property` `value` or
  none. A `float`, `vec3` or `vec4` is animated; a `vec2` is only set
  (`a vec2 value is set, not animated`). At most 16 a value; `stop` ends
  one, the value back to what was last set.
- **Limits:** 32 values a client, 128 in all (`too many values`). A value
  is the client's own: another client's layers cannot follow it (`no such
  value`), nor a layer on another target (`the value is on another
  target`).
- **Dropped** with `drop`: every uniform that followed it takes its own
  value again. Values are made again, set and animated, in each new scene
  of their target, before the layers; the client libraries send them again
  after a reconnect with the assets, and the links with the binds.
- **An older service** answers `value` and `link` with `unknown op`, and
  an `animate` of a value with `no such layer`; its uniforms keep their
  own values.

```json
{"op":"value","ref":20,"target":"panel","type":"float","v":"0.5"}
{"op":"link","ref":4,"name":"u_glow","value":20}
{"op":"link","ref":7,"part":2,"name":"u_glow","value":20}
{"op":"animate","ref":20,"anim":1,"keys":"0:0 600:1 1200:0","loop":1,"interp":"smooth"}
```

### Canvases

Send these only to a service whose hello has `canvas` 1. A canvas is a
client's off-screen picture on a target: `w` x `h` RGBA, drawn in by the
client's effect and mesh layers made with its `canvas`, and sampled by
layers on the target (its own or the client's others, not those drawn in
it) through `bind`, as an asset. A layer drawn in a canvas samples only
canvases made before its own (else `a layer in a canvas samples only
canvases made before its own`): those are drawn first in each frame, so
it never reads a picture not drawn yet.

| Field | Default | |
|---|---|---|
| `w`, `h` | — | 1-2048 |
| `depth` | 0 | 1: a depth-stencil buffer of its own, for parts' depth tests and the [stencil](#render-state) fields |
| `clear` | `0 0 0 0` | the RGBA (0-1) it is cleared to at the start of each frame it is drawn |
| `once` | 0 | 1: drawn once, and again only with the flush that changes something in it (a layer in it written, moved, shown or hidden; an asset or a canvas a layer in it samples written or drawn), and when its target is shown again after being parked or locked; its layers' animations and `time` do not move it in between |
| `sampling`, `wrap`, `wrap_u`, `wrap_v`, `anisotropy` | `nearest`, `clamp`, 1 | as an asset's, without mipmaps |

- **Drawn** by the display's renderer, in passes of the canvas's own,
  before the target's own passes and after those of the canvases made
  before it; its first pass clears it. The canvas's layers are ordered among
  themselves by `class`, `z` and age, are drawn as a layer on screen is
  (visible and ready, nothing they sample refused, and once what they
  sample is written: `waiting`, `an asset it samples is not written yet`),
  and are never in the target's stack: they make no target wanted, are not
  faded, suspended or held, and show (`layer` event `shown`) once drawn in
  it. A layer on screen sampling the canvas wants the target as any layer.
  A canvas without `once` is drawn each frame only while a layer drawn on
  screen samples it, directly or through layers drawn in other canvases;
  the rest of the time the display skips it, keeping its last picture.
- **Premultiplied:** a layer drawn in a canvas at the default `alpha`
  blend over its clear leaves colour already multiplied by alpha, as a
  canvas cleared transparent holds. Sample a canvas with `blend`
  `premultiplied` (or `none` where it is opaque): at `alpha` its colours
  are multiplied by alpha twice, darkening its soft and bilinear-sampled
  edges.
- **Costs** nothing of the upload budget to draw: only what its layers
  write is sent. Its pixels twice (what its passes draw, and the copy
  layers sample: the picture turned so that its first row is its top, as
  an asset's), and once more with `depth`, count in the
  service's pixel memory. A client's canvases together take at most half
  of it (8,192 KB of the usual 16 MB): its canvases alone cannot fill it,
  though its canvases, assets and layers together still can. A canvas
  the display draws every frame costs its GPU while something shown samples
  it: a still picture takes `once`.
- **Limits:** a client has at most 4 canvases and all clients together 8
  (past either: `too many canvases`), and a target's canvases together at
  most 2048x2048 pixels.
- **Dropped** only with no layer drawn in it or sampling it (`canvas in
  use`); a client gone takes its layers first, then its canvases.
- **Made again** in each new scene of its target, with its layers, as
  assets are. The client libraries make canvases with the assets after a
  reconnect, before the layers, and hold a canvas, the layers drawn in it
  and binds of it until the service's hello has `canvas` 1: an older
  service, which knows no `canvas` field, would draw such a layer on the
  target itself.

### Scene files

On a target with `<target>_scene_files` 1 (cluster-render.conf; 0, off, on
every target as shipped; the RAMSES 19 backend), a client may have the
service load a RAMSES scene file as the target's whole scene in place of
the layers: content authored beforehand, saved with its resource files
(`RamsesClient::saveSceneToFile`), drawn by its own cameras and passes, and
changed live by edits ([below](#scene-edits)).

| Field | |
|---|---|
| `file` | the scene file, an absolute path |
| `res` | its resource files, absolute paths separated by spaces (at most 16; none: empty) |
| `sha256` | the SHA-256 of `file`, then of each file of `res` in its order: hex, separated by spaces |
| `contend` | as a layer's |
| `layers` | 0 (default): the target's layers wait while the file is there; 1: they are drawn over it ([below](#layers-over-a-scene-file)) |
| `layers_order` | with `layers` 1: the render order the layers' passes start at, -999737856 or above (the [canvases'](#canvases) passes go below); left out: one past the file's highest |
| `over_order` | with `layers` 1: the render order the `overlay` and `alert` layers' passes start at ([below](#layers-over-a-scene-file)); left out: they start with the others |

The service runs as `hmi_5000` and any client may name a file, and a
malformed file can take the RAMSES client down with the service, so it takes
only files that a root install put in place and nobody else can change:
each file's real path (symlinks and `..` resolved) must be under
`/var/opt/`, a regular file, and it and every folder below `/var/opt/` on
the way owned by root and writable by no one else; and each file's SHA-256
the one given (the files at most 256 MB together: they are hashed then, in
the render loop). Anything else is refused with an `error` event (`op`
`scene`). The file is loaded when the target's scene is published; it keeps
the scene id it was saved with, which must be the target's
(`<target>_scene_id`; a panel that has fallen back has
`panel_fallback_scene_id`), else the scene is in
`error` with the reason.

A target has at most one scene (another is refused: `the target has a
scene file already`). While it is there and has not failed to load, the
target is wanted, as by a layer that wants it, and, unless the scene has
`layers` 1, every layer on it is
`waiting` with `reason` `scene <ref>` (the client's own scene) or
`scene of <app>`, as below an exclusive layer. The scene's `layer` events:
`waiting` (the target not shown yet: its state and reason, the `target`
event naming who holds the slot), `shown` once the display shows the target
with this scene (where the service sees the renderer's subscriptions, once
the renderer has it), `error` when the file did not load. A client sends
its values again on `shown`. `drop`, or the client gone, ends the scene:
with nothing else wanting the target, it stays shown through
`<target>_linger_ms` and the target is released; a target the layers want
is published again with them at once. A scene coming to a target, or going
from one the layers want, takes the target out of its slot and asks for it
again with its new scene.

`scene` sent again with the scene's ref (its target unchanged) loads the
new file in place: the scene is unpublished and published again with the
same id while the target keeps its slot, and its kept edits (and hosts) go. A `layer`
event follows even when the state is the same.

### Scene edits

`lines`: lines separated by newlines (`\r\n` too; empty ones skipped), each
a kind, a space and its value. `RE` is a POSIX extended regular expression
found anywhere in an object's name (as `grep -E`, no back-references), at
most 256 characters; numbers are separated by commas.

| Line | Sets |
|---|---|
| `--hide RE`, `--show RE` | the visibility of each node matching and of every node under it |
| `--move RE=x,y,z`, `--scale RE=x,y,z` | a node's translation, its scaling |
| `--rotate RE=x,y,z` | a node's rotation: degrees, in the scene's own convention (nothing converted) |
| `--viewport RE=x,y,w,h` | a camera's viewport: pixels, from the bottom-left as RAMSES has it |
| `--pass-off RE`, `--pass-on RE` | a render pass disabled, enabled |
| `--uniform RE:NAME=v[,v...]` | the uniform `NAME` of each matching mesh's appearance: as many whole elements as given and it has (float, vec2-4, mat2-4; int and ivec2-4 rounded); one bound to a data object is not set (`--set` it) |
| `--set NAME=v[,v...]` | the data object called `NAME` (the name, not a pattern): float, int, vec2-4 |
| `--play NAME`, `--skip NAME` | to a service whose hello has `scene_anim` 1: the animation sequence called `NAME` (the name, not a pattern) of an animation system the file has, interpolated by the renderer ([below](#playing-a-files-animations)). `--play` starts it from its start (from there again when it is playing or has played); `--skip` shows its end at once (it is started as long ago as it lasts) |

A line replaces the kept line with the same key, its kind (`--show` counts
as `--hide`, `--pass-on` as `--pass-off`, `--skip` as `--play`) and what
comes before its value (up to the last `=`), and goes to the end. The kept
lines, at most 1024, are applied in that order to each scene the file is
loaded into, so a scene published again shows what the lines so far made
of it. New lines are applied once a tick, in the target's one flush (not
while the target is parked; none when they change nothing). A pattern is
resolved once per scene and kind of object, and cached by its text.

`--play` and `--skip` are events, not values: each waits like any line
(a newer one of the same sequence in its place), is applied once, and is
not kept. A scene published again shows the file as saved with the kept
lines, and plays nothing until another comes; the clients do not send them
again after a reconnect. Sent on `shown`, the play is seen from its start.

#### Playing a file's animations

What a sequence does at play depends on its animation system:

- **Without a clock of its own** (`Scene::createAnimationSystem`), the
  recommended kind: the service sets the system's time, from the play on,
  once a tick in the target's flush (one small scene action a flush), the
  renderer interpolating every property at that time. The last time set is
  the end of the last sequence playing in the system; then nothing is sent
  until the next play. While the layers' writes wait on the upload budget a
  tick is left out, never holding them, and the next one catches up to its
  time, so the motion steps but never runs late. Nothing depends on the
  renderer's clock. A sequence played like this lasts at most 10 minutes
  (one that loops forever is refused). The system's time only goes forward;
  the service starts it at 10 minutes or more.
- **Real-time** (`Scene::createRealTimeAnimationSystem`): nothing is sent
  while it plays, but the renderer plays it on its own clock, against a
  start the service stamps from the head unit's clock plus
  `scene_realtime_offset_ms` (cluster-render.conf, default 0; the time used
  is logged). A display whose clock is not the head unit's, nor kept in step
  with it, starts it that much early (its start partly skipped, or only its
  end shown) or late (nothing moving until then). Use the kind above on such
  a display.

For a rest state that is right whatever happens (a renderer that never
plays it, a play cut short, the scene published again), save the file with
each animated value at its last key's value and start nothing in the file.

A malformed line is refused at once, the other lines of the message taken:
an `error` event, `op` `edit`, `line` the line, `reason` naming it and
why. A line that changes nothing (no object matches, no mesh has the
uniform, not a regular expression, no such sequence) is reported the same
way, once per loaded scene.

### Layers over a scene file

A scene with `layers` 1 has the layers on its target, every client's, drawn
over the file: in the file's own scene, with a camera and render passes of
the service's that never clear, from render order `layers_order` up, one
order a pass (the quads between two mesh layers share one; each mesh layer
takes one), or from one past the file's highest pass without it. A pass of
the file ordered above all of them is drawn over the layers: the file's
owner can keep frame lines, an edge that fades into the file's artwork, or
a shape cut out of it on top of what the layers draw. The layers are
arranged, faded, written and flushed as on any target, the scene's edits
in the same flush, within the same budget; the file's resources are charged
as without layers. The edits never wait for the layers: while a layer holds
the target's flushes (a buffer left half written, an uncover the budget
defers), the flush goes for the edits all the same and the layers' writes
count as not gone (a video writes whole next), so what a layer wrote may
show half done meanwhile. `scene` sent again with `layers` 0 publishes the
file again without them, and they wait. A display that draws nothing over
files (iDrive 8) leaves the layers waiting, the file shown, and logs why.

With `over_order` the layers of class `overlay` and `alert` are drawn in
passes of their own from render order `over_order` up instead, one order a
pass as above, in the same stack order: a file can then keep a pass between
the two bands, over the content its owner wants under its artwork (a hosted
map from a low `layers_order`) and under the overlays (a panel drawn over
its artwork, from an `over_order` past the file's highest). Without it, or
on a service whose hello lacks `over_order` 1 (an older one ignores the
field), every class is drawn from `layers_order` as before.

### Hosting another target

A scene with `layers` 1 (or, with no scene, a client's layers:
[Hosting from layers](#hosting-from-layers)) may show another target's content: `host` tells
every client that `target` is hosted in the scene's target, at `x`, `y`,
`w`, `h` there (inside it), and which part of `target` it shows: `src_x`,
`src_y`, `src_w`, `src_h` in `target`'s pixels (inside it; all four or none:
none is all of it), stretched over the rect; `shown` 0 shows it nowhere.
The service only keeps this and tells the clients (the `host` event); it
moves nothing. A producer of `target` that follows it puts its layer in the
scene's target where that part of its own drawing lands in the rect, with
only that part of its picture, and nothing on `target`, so `target`'s slot
is let go; with `shown` 0 it has no layer at all. A producer that does not
know the event keeps drawing on `target` as before. The event says a target
is hosted only while the scene can draw it: its file published as the
target's scene with the layers over it; at other times (not published yet,
published again, a display that draws no layers over files) it says the
target is not hosted, so a producer stays where it can be seen. `host` sent
again with the same `target` replaces it. A target is hosted by one scene at
most (another's is refused: `target T is hosted by another scene`), never
by a scene on itself. A `host` refused (the `error` event names its
`target`) ends that scene's host of that target, if it had one. Hosting ends
when the scene goes (`drop`, its client gone), is sent again (another file,
or `layers` 0: its hosts go with its edits), fails to load, or the display
draws no layers over it. The client libraries keep a scene's `host`
messages and send them again after a reconnect, except one the service
refused or one whose scene was sent again since, and send none for a scene
without `layers` or for the scene's own target.

A host may also ask for an edge on the hosted picture, for a rect shorter
than the shape the scene shows it in: the service draws the rows 2 px in
from the top and from the bottom of each video another client draws inside
the rect (the hosted producer's) on past it, `edge_top` px above and
`edge_bottom` px below (held within the scene's target), blurred along the
row by a Gaussian of sigma `edge_blur` px (0 to 32; 0: not blurred), and
darkened with the distance d from the rect to max(1/4, 1 - d / `edge_dim`)
(0: not darkened); the picture's own rows fade into the edge over
`edge_fade` px inside the rect. All five default to 0; with `edge_top` and
`edge_bottom` 0 there is none. The edge is drawn by the service over the
video, in its fade, and only while the host is shown; the producer sends
nothing more for it, and the `host` event does not carry it. Unturned
videos only, and not for videos the target draws through one composite.
Send them only to a service whose hello has `host_edge` 1 (an older one
ignores them, and draws no edge).

### Hosting from layers

A client that draws a target with layers only (a cluster theme on `panel`)
hosts another target there with no scene file: `host` with `into`, the
target its layers are on, in place of `ref` (not both: refused). Every other
field, the `host` event, the part, the edge and `others_fps` are as
[above](#hosting-another-target); `w`, `h`, `src_w` and `src_h` are at least
64 and 32 (smaller is refused: the producer draws nothing smaller). A
producer that follows the event puts its layer in `into` at the rect, as
for a scene, and marks it with the layer field `hosted`, the hosted
target's name, so the service knows it.

- **Live.** A client's host is *eligible* while it is shown (`shown` 1:
  with `shown` 0 it would show the picture nowhere, so it is not live and
  the picture stays on its own target), `into` is on screen (its scene
  published, and the target `shown`, `lingering`, or kept through a lock
  with its last flush), `into`'s layers are not waiting for a scene file (one with
  `layers` 1 keeps them drawn), and the client has a layer drawn and seen
  over the host's rect: visible, ready, not suspended, overlapping the rect,
  at or above the client's own topmost `exclusive` layer, and, for a video
  or image, not at opacity 0 (an effect or mesh draws what its shader does
  and counts as seen). The lowest such layer is its *anchor*, the topmost
  its *top*. Of a target's eligible hosts on one `into`, the one whose top
  is highest in the stack is *live*: the client the driver sees over the
  picture. A host sent early with a small or low layer of a background app
  loses to the theme drawn over it; to win, a client must draw over the
  other hosts there, and the picture is then drawn over them too (below).
  Of hosts on different `into`s, the `into` that holds the target (the
  last live host's) keeps it while any host there is eligible, also after
  that host ends or goes, and the rule above picks among them: a host on
  another `into` waits, and takes over only once none on the holding one is
  eligible (hidden, ended, `shown` 0, gone, its `into` off screen); with
  none holding, the `into` whose host was sent first wins (a host ended and
  sent again counts as sent then). None is live while a scene hosts the target: a scene's host is as without hosts
  from layers, and wins. Only the live host is in the `host` event; with
  none, the event says `target` is not hosted, so a producer goes back to
  its own target. This is decided again at every loop of the service, from
  the layers' states: all of the client's layers over the rect hidden or
  suspended, the stock HMI taking `into`, or a scene file without `layers`
  coming takes the picture back to its own target; when that ends, it is
  hosted again.
- **Stacking.** The live host's producer's videos (another client's on
  `into` with `hosted` the hosted target) are drawn just under the anchor,
  or just over it when the anchor is `exclusive`, so no exclusive layer of
  the host hides them, and never under a seen layer that an eligible host
  it won over draws over both its own rect and this one: under the host's
  frame and readouts, over what is below
  (another client's lower layers, a scene file with `layers` 1). Their own
  `class` and `z` do not count while they are hosted. Every other layer,
  another client's video inside the rect included, keeps its place. A layer
  meant to be seen through the rect is cut out or transparent there. A
  producer that does not mark its layer (a waze-on-cluster that doesn't
  send `hosted`) is drawn in the rect at its own place in the stack, and
  the host's edge is not drawn on it either. A client that hosts nothing,
  or whose host is not eligible, never moves the picture.
- **`hosting` event.** The client is told whether its host is live, and
  while it is not, why: `it shows the target nowhere (shown 0)`, `no layer
  of the client is drawn over its rect on P`, `P is not on screen
  (STATE)`, `P's layers wait for a scene file there`, `target T is hosted
  by a scene`, `target T is hosted by another client's layers, drawn higher
  over it`, or `target T is hosted by another client's layers on P2, there
  first` (with `by`, that client's name). It comes when the state or the
  reason changes, after the service has first decided, and again from the
  start for a new host.
- **Several hosts.** A client has one host from layers a target; sending
  it again replaces it, also into another target. Another client's host of
  the same target is never refused for it: it waits. Other clients may have
  layers on `into` all the same.
- **End.** `unhost` with `into` and `target`, or the client gone (any way
  the connection ends: exit, crash, a closed socket): the host ends and
  every client is told. A `host` with `into` refused (the `error` event has
  `target` and `into`) ends the client's host of that target, whatever
  `into` it had, so a refused move to another target leaves nothing. The
  client libraries forget it too, unless they have sent a `host` of that
  target into another target since, which the service takes after the
  refusal. Their `unhost` is sent even when they keep nothing, so it ends
  whatever the service holds. A service restarted holds nothing until the
  client sends it again (the client libraries do, after the hello). Nothing
  is written to disk.
- **The producer.** A producer that cannot draw the host's place (its part
  misses the picture, or lands smaller than it draws, or the service
  refuses its layer there) keeps drawing on its own target until the host
  changes, so a host never leaves the picture nowhere; waze-on-cluster
  does. This holds for a scene's host too: one whose part misses the
  picture, or lands smaller than 64x32, shows the picture on its own
  target.
- **Known limits.** The service sees layers, not pixels. A client that
  draws a transparent effect or mesh over the theme, in a higher class, is
  taken as seen and can win on that `into`; the picture then shows at that
  client's rect (at least 64x32). Any client could already cover a theme
  with an exclusive alert layer, so this is no new way to hide content.
  Across different `into`s the service cannot tell which screen the driver
  wants: with nothing holding, the earliest eligible host wins and keeps
  the picture while it stays eligible, so an app that drew something on
  another target on screen first can keep the picture there, at least
  64x32.
- **Cost.** The producer's picture goes into `into` in place of its own
  target, as with a scene's host: one decode and one upload, of the part
  shown, at most its own target's size (a hosted map is at most its
  1088x480, 783,360 bytes a frame, never the 1920x720 panel's).
- **iDrive 8.** The same: the service draws layers on every target of
  both backends, so nothing here depends on scene files or RAMSES 19.

Send `host` with `into` and `unhost` only to a service whose hello has
`host_layers` 1. An older one refuses such a `host` (`no such scene`) and
does not know `unhost`; the client libraries keep the host and send it once
a service that takes it is connected. A layer's `hosted` may go to any
service: an older one ignores it.

A theme on `panel` showing the map at 600,120, 720 by 480, with the map's
centre part:

```
{"op":"layer","ref":1,"target":"panel","kind":"image","iw":1920,"ih":720}
F ref 1, the theme's artwork, transparent where the map shows
{"op":"host","into":"panel","target":"map","x":600,"y":120,"w":720,"h":480,
 "src_x":184,"src_y":0,"src_w":720,"src_h":480}
```

### Bandwidth for a layer

While a layer with `others_fps` is `shown`, every video layer of the other
clients is written at most `others_fps` times a second (its own `fps` when
that is lower), so this client's layers get the upload budget they leave.
A target's videos composed into one go at the highest rate their clients
are held to, or at their own when one of them is not held. Of several such
layers the lowest `others_fps` holds; a client's own videos are never held
by its own layers. 15 is the least: half the 30 a second a map is made at,
below which a panning map visibly stutters.

The hold ends as soon as the service sees the layer is not shown (within
its next loop, at most 250 ms): hidden, waiting
(its target taken or not shown yet), dropped, `set` with `others_fps` 0,
or its client gone, whatever way the connection ends. Nothing is kept: a
service restarted holds nothing until a layer asks again, and the held
videos' own `fps` is never changed. Each held client gets an `fps_cap`
event when its hold starts, changes or ends, so a producer can make
pictures no faster than they are written; a client never held gets none.
The same on iDrive 7 and iDrive 8: the budget and the videos' clocks are
the service's on both.

## Service to client

Every JSON message has `ev`.

| ev | Fields | When |
|---|---|---|
| `hello` | `proto`, `backend` (`id7`, or `id8` on iDrive 8), `targets` (`map:1088x480,panel:1920x720,hud:800x480`; on iDrive 8 `map:874x749,hud:353x203,guide:702x213,widget:2240x896,popup:2240x896`, then any a drop-in adds, README.md "iDrive 8"), `repeat` (1: takes `repeat`), `always_packed` (1: takes a video layer's `always_packed`; absent from older services), `host_edge` (1: takes a `host`'s `edge_*`; absent from older services), `preload` (1: knows a layer's `preload`; absent from older services), `others_fps` (1: knows a layer's `others_fps`; absent from older services), `render_state` (1: takes the [render state](#render-state) fields), `samplers` (1: takes the [mipmaps and samplers](#mipmaps-and-samplers) fields), `host_layers` (1: takes `host` with `into`, `unhost` and a layer's `hosted`; absent from older services), `canvas` (1: takes [canvases](#canvases) and the stencil fields), `curves` (1: takes the eased `interp`s, [above](#animations)), `nodes` (1: takes [pivots and parents](#part-hierarchies)), `draw` (1: takes [draw modes](#draw-modes-and-instances)), `instances` (1: takes instances above 1, [same place](#draw-modes-and-instances)), `cube` (1: takes [cube maps](#cube-maps)), `values` (1: takes [shared values](#shared-values)), `text` (1: takes [fonts and text layers](#text); 0 where the renderer refused their shaders; absent from older services), `shm_frames` (1: takes [shared frames](#shared-frames); absent from older services and off Linux), `scene_anim` (1: takes the [edit lines](#scene-edits) `--play` and `--skip`, the display able to play a file's animation sequences; 0 where it cannot; absent from older services), `over_order` (1: takes a `scene`'s `over_order`; absent from older services) | after the client's hello |
| `layer` | `ref`, `state`, `reason` | the layer's state changed |
| `target` | `target`, `state`, `holder`, `reason`, `retry_in_ms`, `rendering`, `guide_disabled`, `disabled` | a target's state changed |
| `budget` | `cap_kb_per_s`, `max_kb_per_s`, `floor_kb_per_s`, `reason` | the upload cap changed |
| `fps_cap` | `fps` (0: not held any more), `app` (the client whose layer holds it; empty with 0) | another client's `others_fps` holds this client's video layers to `fps` updates a second, at another rate, or no longer ([above](#bandwidth-for-a-layer)) |
| `shm` | `ref`, `ok` (1: the layer's frames may go through its shared buffer), `reason` (why not, with 0) | the answer to `shm` |
| `error` | `op`, `ref`, `reason`; `line` for an edit line; `target` for a `host`, and `into` for one with `into` | a message was refused, or an edit line changed nothing |
| `status` | `text` | after a status request; among its lines, one for each slot the KOMBI's latest reports name: `slot 0x203 status 2: 0x1000400 class 0 map 1, ...` (each row's content, class and map status) |
| `hosting` | `target`, `into`, `state` (`live` or `waiting`), `reason` (waiting: why), `by` (the client whose host from layers is live in its place; else empty) | to a client with a host from layers, when its state or reason changes ([above](#hosting-from-layers)) |
| `host` | `target`, `into` (the hosting scene's or layers' target; empty: `target` is not hosted any more), `shown`, `x`, `y`, `w`, `h`, `src_x`, `src_y`, `src_w`, `src_h` | after the client's hello for each hosted target, and to every client when a host comes, changes or ends ([above](#hosting-another-target)); the same for a scene's host and a host from layers |

Layer states (a scene's too, [above](#scene-files)): `shown`; `waiting`
(its target is not shown yet or is taken, an asset it samples is not
written yet, or a scene file without `layers` 1 is on its target; `reason`
says which);
`suspended` (below an exclusive layer); `stalled` (no content yet: no frame,
no part with geometry, an asset it samples without pixels; or a video's
frames stopped); `hidden`; `error` (the renderer refused it). Target states:
`idle`, `acquiring`, `parked` (mapped, behind the content the slot shows:
`holder` `stock` or `foreign` once the slot table names it, and `reason`
`parked behind stock`, `parked behind foreign`, or `parked` until then; on
iDrive 8: offered, until the cluster shows it), `shown`, `lingering`,
`waiting` (with `holder` `stock` or `foreign` when
someone else holds the slot, and `retry_in_ms` when on a timer),
`unavailable`, `loading` and `loaded` (a `preload` layer's target: its
scene being loaded, and loaded, by the display, not shown; the slot shows
other content). `rendering`, for a shown or lingering target: `verified`
(the display's renderer is subscribed to its scene), `checking` (not
subscribed yet; after 1.5 s shown the service asks for the slot again),
`unobservable` (the service cannot see subscriptions); `none` otherwise.
`guide_disabled` and `disabled` are always 0; no target or guide hold is
ever turned off for good. A client treats a target or layer state it does not
know as not shown: states are added as the service learns new ones, and
`loading` and `loaded` occur only on a target some client preloads.

On a head unit that refuses the service (README.md "Supported head
units") no `hello` comes: a `status` request gets `text` `not supported on
this car (head unit: ...)`, and every other message an `error` event with
that `reason`.

A client that does not read its events (over 1 MiB waiting) is
disconnected.

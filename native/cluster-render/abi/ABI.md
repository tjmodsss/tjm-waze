# libramses 19.0.14 ABI

Headers (`include/ramses19/`), a symbol list and a link stub for the head
unit's `/usr/lib/libramses-shared-lib-wayland-ivi-egl-es-3-0.so.19.0`
(BuildID `51549f9a62e9e317b6d3786f731b894baacbf39c`, SHA-1
`2e03c21f0012855afffbeac030ad15ea51a00910`). RAMSES is BMW Car IT's
open-source renderer (https://github.com/bmwcarit/ramses, MPL-2.0). The
headers declare version 19.0.14's API as the unit's library exports it
("Differences from upstream 25").

Labels:

- **VERIFIED**: seen in the binary (symbol, disassembly at the given address)
  or observed by running the real library ("smoke": a test program built on
  these headers and run on a copy of the unit's root filesystem, not part of
  this repository; and `make test-ramses`).
- **INFERRED**: reasoning from verified facts.

Addresses are the library's VAs. "The HMI" is the unit's HmiMain3D, a
client of the same library.

## Using it

```make
RAMSES19_SONAME = libramses-shared-lib-wayland-ivi-egl-es-3-0.so.19.0
$(BUILD)/stub/$(RAMSES19_SONAME): abi/libramses19.symbols
	mkdir -p $(@D)
	python3 tools/ramses_abi.py stub-source $< > $(@D)/ramses19_stub.c
	gcc -shared -Wl,-soname,$(RAMSES19_SONAME) -o $@ $(@D)/ramses19_stub.c
# link: g++ -Iabi/include -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 ... $(BUILD)/stub/$(RAMSES19_SONAME)
# then: python3 tools/ramses_abi.py check-imports BIN abi/libramses19.symbols
```

- `#include "ramses19/ramses.h"`, namespace `ramses`.
- **Toolchain:** gcc 7.5 and libstdc++ (`../Makefile`, `../docker/Dockerfile`), because libvsomeip3 needs them (`../dcsm/DCSM.md`). No API in the reconstructed set takes a `std::` type.
- **`check-imports`** fails the build if any `ramses` import is missing from the unit's export list.
- **Object classes:**
  - Library-owned objects (Scene, Node, …) are declared with deleted constructors and destructors. Release them with `Scene::destroy` or `RamsesClient::destroy`.
  - Value objects (configs, `EffectDescription`, `UniformInput`, …) are constructed by the library's own constructor into 64 bytes of storage.

## Evidence per item

| Item | Evidence | Label |
|---|---|---|
| Every declared function exists with these parameter types | link against the stub + `check-imports` against `libramses19.symbols` (the lib's `.dynsym`, less the text API) | VERIFIED |
| Base classes | exported RTTI (`_ZTIN6ramses…`): every public class is single-inheritance (`__si_class_type_info`); the only `__vmi_class_type_info` objects are `ramses_internal`, CommonAPI or vsomeip types. So every base sits at offset 0 | VERIFIED |
| `AnimationObject : SceneObject`, `RamsesRenderer`/`RendererConfig`/`DisplayConfig : StatusObject` | RTTI base pointers | VERIFIED |
| Value-class size | constructors: `StatusObject` base = vptr + impl (`StatusObjectC2` 0x95fc7 writes `[this+8]`); derived configs copy impl to `[this+0x10]` (`RamsesFrameworkConfigC1` 0x877b0, `SceneConfigC1` 0x1f4dc0, `EffectDescriptionC1` 0x1a9160, `RendererConfigC1` 0x25317f, `DisplayConfigC1` 0x23903f) → 24 bytes. `UniformInput`/`AttributeInput` (via `EffectInputC2` 0x1af6d8) → 24 bytes. Headers reserve 64 | VERIFIED |
| `RamsesFramework` 8 bytes, `RamsesClient` 0x20, `RamsesRenderer` 0x18 | the HMI's `operator new(8)`, `(0x20)` and `(0x18)` before the constructors; lib constructors write `[this]` / up to `[this+0x18]` / `[this+0x10]` | VERIFIED |
| `UniformInput`, `AttributeInput`, `EffectDescription` export no destructor | `.dynsym`; the HMI destroys an AttributeInput by calling `EffectInput::~EffectInput` (D2) directly. The headers' inline destructors do the same, and `StatusObjectD2` (0x95f70) releases the impl | VERIFIED |
| `resourceCacheFlag_t` passed by hidden reference | `RamsesClient::createEffect` 0x1cd0a1 `mov eax,[rdx]`; the HMI passes `lea rdx,[rbp-0x90]`. Header gives the class a user-provided copy constructor so clang does the same | VERIFIED |
| Value enums (`ETextureFormat`, `ETextureAddressMode`, `ETextureSamplingMethod`, `EDepthWrite`, `EInputType`, `ETextureCubeFace`) | by calling the exported `ramses::get*String(E)` functions for every value (bounded tables, e.g. `getTextureFormatString` 0x224880). A name table alone can mislead (`EDrawMode`, below), so the render-state enums are traced to the GL call instead | VERIFIED |
| Render-state enums, how they were traced | each `Appearance::set*` converts by an int32 table that is the identity on the declared range; the renderer copies the scene's render state into its cache unconverted (0x37d14a–0x37d212); 0x37a8e0 passes it to `Device_GL` (vtable 0x9ca0f8), whose methods convert by tables at 0x6cf8xx and jump to the GL function. The transport between client and renderer is not traced byte by byte. `make test-ramses` sets every value on a part and reads back the library's own integers with the getters (`read_look_raw`, not through the backend's tables), each compared with the number traced in the rows below, blending off as Disabled 0 for both operations; a backend table out of the library's order fails it | VERIFIED |
| `EBlendFactor`: Zero 0, One 1, SrcAlpha 2, OneMinusSrcAlpha 3, DstAlpha 4, OneMinusDstAlpha 5 | `setBlendingFactors` 0x19b680 → 0xa8ff0, table 0x69a6b0 = 0–5; `Device_GL` 0x59cfd0, table 0x6cf8c0 = GL_ZERO, GL_ONE, 0x302–0x305 (SRC_ALPHA, ONE_MINUS_SRC_ALPHA, DST_ALPHA, ONE_MINUS_DST_ALPHA) → `glBlendFuncSeparate` (0x59d01a) | VERIFIED |
| `EBlendOperation`: Disabled 0, Add 1, Subtract 2, ReverseSubtract 3, Min 4, Max 5 | `setBlendingOperations` 0x19c450 → 0xa9090 (refuses one of the two Disabled alone), table 0x69a6f0 = 1–5; `Device_GL` 0x59d980: 0 → `glDisable(GL_BLEND)`, else table 0x6cf8a0 = FUNC_ADD, FUNC_SUBTRACT, FUNC_REVERSE_SUBTRACT, MIN, MAX → `glBlendEquationSeparate` (0x59d9b6) | VERIFIED |
| `ECullMode`: Disabled 0, FrontFacing 1, BackFacing 2, FrontAndBackFacing 3 | `setCullingMode` 0x1a0080 → 0xa9290, table 0x69a680 = 0–3; `Device_GL` 0x59d9d0: 0 → `glDisable(GL_CULL_FACE)`, else table 0x6cf838 = FRONT, BACK, FRONT_AND_BACK → `glCullFace` (0x59d9eb) | VERIFIED |
| `EDepthFunc`: Disabled 0, Greater 1, GreaterEqual 2, Less 3, LessEqual 4, Equal 5, NotEqual 6, Always 7, Never 8 | `setDepthFunction` 0x19dbe0 → 0xa9120, table 0x69a640 = 0–8; `Device_GL` 0x59d950: 0 → `glDisable(GL_DEPTH_TEST)`, else table 0x6cf8e0 = GREATER, GEQUAL, LESS, LEQUAL, EQUAL, NOTEQUAL, ALWAYS, NEVER → `glDepthFunc` (0x59d96b) | VERIFIED |
| `EStencilFunc`: Disabled 0, Never 1, Always 2, Equal 3, NotEqual 4, Less 5, LessEqual 6, Greater 7, GreaterEqual 8 | `setStencilFunction` 0x19e640 → 0xa91b0, table 0x69a5e0 = 1–8; `Device_GL` 0x59da00: 0 → `glDisable(GL_STENCIL_TEST)`, 1 → NEVER, 2–8 by table 0x6cf880 = ALWAYS, EQUAL, NOTEQUAL, LESS, LEQUAL, GREATER, GEQUAL → `glStencilFunc` (0x59da2c), ref and mask unchanged | VERIFIED |
| `EStencilOperation`: Keep 0, Zero 1, Replace 2, Increment 3, IncrementWrap 4, Decrement 5, DecrementWrap 6, Invert 7 | `setStencilOperation` 0x19f300 → 0xa9210, table 0x69a5a0 = 1–7 (0 kept); `Device_GL` 0x59d020, table 0x6cf860 = KEEP, ZERO, REPLACE, INCR, INCR_WRAP, DECR, DECR_WRAP, INVERT → `glStencilOp` (0x59d04d) | VERIFIED |
| `EDrawMode`: Points 0, Lines 1, Triangles 2, TriangleStrip 3, LineLoop 4 (RAMSES 27's order) | `Appearance::setDrawMode`'s table 0x69a560 maps them to the internal Points 0, Lines 1, LineLoop 2, Triangles 3, TriangleStrip 4; `make test-ramses` reads a new appearance's mode back as 2 (`getDrawMode`), and every mode as set; on a stand-in renderer on the unit's library 2 draws triangles and 3 a strip. `getDrawModeString` (0x1a4740) indexes the internal names with the public value, so its order is not the enum's | VERIFIED |
| `ERenderBufferType` Color 0, Depth 1, DepthStencil 2; `ERenderBufferFormat` R8 0, RG8 1, RGB8 2, RGBA8 3, R16F-RGBA32F 4-11, Depth24 12, Depth24_Stencil8 13 (no RGBA4); `ERenderBufferAccessMode` WriteOnly 0, ReadWrite 1 | `Scene::createRenderBuffer`'s checks (0x111e57: type 0 takes formats 0-11, 1 takes 12, 2 takes 13) and `RenderBufferImpl`'s tables (0x69edb8 type, 0x69ed80 format, the access mode by compare) | VERIFIED |
| Texture formats: `ETextureFormat_RGBA8` = 5, `ETextureFormat_R8` = 1 (also RG8 2, RGB8 3, …, ASTC 22–49) | as above; smoke creates RGBA8 Texture2D and RGBA8/R8 Texture2DBuffers | VERIFIED |
| `ERenderBufferType`: Color 0, Depth 1, DepthStencil 2 | `SceneImpl::createRenderBuffer` 0x111e10, at 0x111e57: type 0 takes formats 0–11 (0x112030 `cmp r8d,0xb; setbe`), type 1 only 12 (0x112040), type 2 only 13 (0x111e6b); `RenderBufferImpl` (0xf0aa6) maps 0, 1, 2 to the internal 3, 1, 2 by the table 0x69edb8, and `getBufferType` (0x1d6d60 → 0xf0b90) maps them back (1 → 1, 2 → 2, else 0) | VERIFIED |
| `ERenderBufferFormat`: R8 0, RG8 1, RGB8 2, RGBA8 3, R16F 4, R32F 5, RG16F 6, RG32F 7, RGB16F 8, RGB32F 9, RGBA16F 10, RGBA32F 11, Depth24 12, Depth24_Stencil8 13; no RGBA4 | `RenderBufferImpl` (0xf0ab9) maps 0–13 to the internal formats 1, 3, 6, 9, 22–29, 20, 21 (R8, RG8, RGB8, RGBA8, the float ones, Depth24, Depth24_Stencil8) by the table 0x69ed80; `getBufferFormat` (0x1d6d70 → 0xf0bc0) maps them back by 0x69ed00, indexed by the internal format less 1 (1, 3, 6, 9, 22–29, 20, 21 back to 0–13; any other reads as 3); on a stand-in renderer on the unit's library, a canvas (RGBA8) cleared transparent and drawn at alpha 0.5 is sampled back as alpha 128, so its format keeps alpha | VERIFIED |
| `ERenderBufferAccessMode`: WriteOnly 0, ReadWrite 1 | `SceneImpl::createRenderBuffer` 0x111e76: mode 0 is made at once, mode 1 only with a sample count of 0 (one a sampler reads); `getAccessMode` (0xf0c00): internal 1 → 0, else 1; RAMSES 27's header has the same order | VERIFIED |
| `RamsesClient::createTextureCube(size, format, mipCount, const CubeMipLevelData*, generateMipChain, cacheFlag, name)`, `TextureCube::getSize`/`getTextureFormat`, `createTextureSampler(..., const TextureCube&, anisotropy, name)` | link against the stub + `check-imports`; `make test-ramses` makes RGBA8 and ETC2RGBA cube textures, samples them, and reads a cube's size and format back | VERIFIED |
| `CubeMipLevelData`: `uint32_t m_faceDataSize`, then the face pointers +X, -X, +Y, -Y, +Z, -Z | `make test-ramses` fills each face with its own byte and saves the texture with `RamsesClient::saveResources` (declared for this): the six faces are in the file in that order, and with +X and -X given in each other's place the check fails; on a stand-in renderer on the unit's library a cube map of six coloured faces sampled by direction shows +Z towards +z, +Y up and -X to the left | VERIFIED |
| `EScenePublicationMode`: LocalAndRemote 0, LocalOnly 1 | `SceneImpl::publish` 0x111a98: 1 → internal 2 ("EScenePublicationMode_LocalOnly"), 0 → internal 1 (LocalAndRemote) | VERIFIED |
| `ESceneFlushMode`: Synchronous 1; Asynchronous 0 is rejected | `SceneImpl::flush` 0x111139 `cmp esi,1` else "Scene::flush: Unknown flushMode"; log table 0x505669; smoke: 0 → status 3 | VERIFIED |
| `EClearFlags` Color 1, Depth 2, Stencil 4 | renderer 0x59cee0: bit0 → `GL_COLOR_BUFFER_BIT`, bit1 → `GL_DEPTH_BUFFER_BIT`, bit2 → `GL_STENCIL_BUFFER_BIT`; `setClearFlags` passes the value through (0xf4d70); default 7 | VERIFIED |
| `EEffectUniformSemantic` 1–12 (ProjectionMatrix … TextTexture) | `EffectDescriptionImpl::setUniformSemantic` 0xc1342: table at 0x69b200 = (3,5,1,2,10,4,6,7,8,9,13,26), which maps all 12 values onto upstream's internal `EFixedSemantics` names consistently | VERIFIED (table); names INFERRED from upstream's internal enum, consistent 12/12 |
| `EEffectAttributeSemantic` TextPositions 1, TextTextureCoordinates 2 | upstream; not exercised | INFERRED |
| `EAnimatedProperty` Translation 0, Rotation 1, Scaling 2; `EAnimatedPropertyComponent` X 0 … Z 2, All 4 | table 0x699df8 = (0,1,2); smoke: Translation/All animates (5,10,15) at 500 ms of 0→(10,20,30), Rotation/Z gives (0,0,45) of 0→90 | VERIFIED (Y 1, W 3 INFERRED) |
| `EAnimationSystemFlags_ClientSideProcessing` = 1 | `createRealTimeAnimationSystem` impl 0x110552 `and esi,1`; smoke reads animated values on the client | VERIFIED |
| `AnimationSystem::findObjectByName` (its own animation objects), `AnimationSequence::getAnimationSequenceStopTime` (`uint32_t`, sequence time), `getPlaybackSpeed` | exported (`check-imports`), upstream signatures (RAMSES 27's headers declare the same); `make test-ramses` starts and skips a sequence of each kind of animation system (`AnimationSystem::setTime` driving the one without a clock of its own) in a scene file it saved, and reads the animated values back | INFERRED until `make test-ramses` runs it |
| `ELoopMode` 0 / 1 | `setLoopMode` impl 0x250749: 0 and 1 handled, others "loop mode value not handled". Names UpdateAndRender / UpdateOnly from upstream | values VERIFIED, names INFERRED |
| `status_t` 0 = OK; `getStatusMessage` on `RamsesClient` / `RamsesRenderer` | smoke: `getStatusMessage(0)` = "OK", flush error 3 = "Scene::flush: Unknown flushMode" | VERIFIED |
| Return types | `status_t` returns checked by running (status 0 every time) for every call the smoke test makes. Void in 19: `RenderPass::getClearColor` (0x1e32a0), `RamsesFrameworkConfig::setDLTApplicationID`/`setDLTApplicationDescription`/`setPeriodicLogsEnabled` (impls 0x88b40/0x88e40/0x89160 return without setting eax) | VERIFIED for exercised calls; the rest of the declared getters/setters follow upstream 25 return types, INFERRED |
| `MipLevelData {uint32 size; const uint8* data}` | upstream layout; smoke creates a 4×4 RGBA8 Texture2D from it and reads back size/format | INFERRED (runtime-consistent) |
| `createTexture2DBuffer(mipLevelCount, width, height, format)` | smoke: `(1, 64, 32, RGBA8)` reports 64×32, 1 level | VERIFIED |
| `Scene::createVertexDataBuffer(maxBytes, EDataType)`, `createIndexDataBuffer`, `VertexDataBuffer::setData(data, bytes, offset)`, `IndexDataBuffer::setData`, `GeometryBinding::setInputBuffer(input, const VertexDataBuffer&, divisor)`, `setIndices(const IndexDataBuffer&)` (text layers' glyph runs) | `make test-ramses`: a run of 256 glyphs made, a 64-glyph line written into it and flushed, rewritten 20 times, a flush each; the scene described whole; nothing logged as an error | VERIFIED |
| `EDataType`: `UInt16` 0, `UInt32` 1, `Float` 2, `Vector2F` 3, `Vector3F` 4, `Vector4F` 5 | `make test-ramses`: a `float`, `vec2`, `vec3` and `vec4` attribute each take a vertex buffer of its declared type, and the library refuses every other pairing ("vertex data buffer type does not match input data type", checked once by hand: 12 refused, 4 taken) | VERIFIED |
| `Texture2DBuffer::setData(data, mip, x, y, w, h)` | smoke: full and sub-rect succeed, out-of-bounds fails with "updated subregion exceeds the size of the target mipLevel" | VERIFIED |
| Renderer objects | smoke `--renderer`: `RendererConfig`, `DisplayConfig` (IVI surface/layer round trip, window rectangle), `RamsesRenderer` construction | VERIFIED (no display created) |
| Scene files: `ResourceFileDescription(const char*)` with `add(const Resource*)`, `ResourceFileDescriptionSet` with `add`, `RamsesClient::saveSceneToFile(scene, file, set, compress)`, `loadSceneFromFile(file, set)` | `make test-ramses`: a scene of nodes, meshes, a camera, two passes and a data object saved with its effect and arrays in a resource file, loaded back with its scene id, published; the descriptions kept until the scene is destroyed. One impl pointer each (upstream), within the 64 bytes reserved | VERIFIED |
| `loadSceneFromFile` makes client resource objects | `make test-ramses`: one more resource (`ResourceIterator`) after loading that file, one fewer after destroying it and the scene; loading it again makes no more | VERIFIED |
| `SceneObjectIterator(scene, type)`, `ResourceIterator(client, type)`, `RamsesObject::getType`, `isOfType` (a type or a base), `Scene::findObjectByName`, `RamsesClient::findObjectByName` (finds a scene by name) | `make test-ramses`: every object of the loaded scene by kind, the loaded scene and its objects found by name | VERIFIED |
| `ERamsesObjectType`, `EEffectInputDataType` | values not reconstructed (32-bit enums, as the library's); learned at run time (`src/graph_ramses19.cpp`): a probe effect's 11 uniforms and a `sampler2D` and a `samplerCube` through `UniformInput::getDataType`, probe objects' `getType`, the bases Node and Resource by `isOfType`. `make test-ramses`: 12 distinct uniform types, the two samplers one type; 5 distinct data object types; node 9, mesh 15, perspective 19, orthographic 20, render pass 71, resource 54 | VERIFIED |
| An effect's uniforms as compiled: `Effect::getUniformInputCount`, `getUniformInput(index, UniformInput&)`, `EffectInput::getName`, `UniformInput::getDataType` | link against the stub + `check-imports`; `make test-ramses` reads an effect's uniforms declared in a list, behind a define, in the `#if` branch taken and after a comment: each reported, by name. Both kinds of sampler report one data type, and `Appearance::setInputTexture` takes a cube texture on a `sampler2D` and a 2D one on a `samplerCube` (RAMSES 27 reports `TextureSampler2D`/`TextureSamplerCube` and refuses both): the backend takes a sampler's kind from its declarations where they agree, and leaves it unknown otherwise (`src/graph_ramses19.cpp` `declared_samplers`) | VERIFIED |
| `Scene::createDataInt32`, `createDataVector3f`, `DataInt32`, `DataVector3f` | probe objects made; their `setValue` | VERIFIED made; `setValue` INFERRED (upstream signatures, exported) |
| `Appearance::setInputValueInt32`/`Vector2i`/`Vector3i`/`Vector4i`/`Matrix22f`/`Matrix33f(input, count, values)` | exported (`check-imports`), upstream signatures; `make test-ramses` exercises the vec4 and float setters only | INFERRED |

## ERamsesCommunicationUser

Taken from the library itself, by calling these internal functions:

| Function | Address |
|---|---|
| name | 0x4299a0 |
| stack | 0x428b70 |
| offered instances | 0x428c50 |
| proxied instances | 0x42b300 |

The table is reproduced exactly. The services in both lists are numbered in this order:

1. SceneRenderer 0xB05E
2. SceneProvider 0xB05D
3. ResourceConsumer 0xB05B
4. ResourceProvider 0xB05C
5. ParticipantInfo 0xB05A

That order is INFERRED from fit: every MGU offer in the unit's generated vsomeip configuration (`vsomeip_gen.json`) matches some participant's own instance in the right slot, and IC_HMI's proxy lists equal its SP/RP/PI sets. VERIFIED: the table values.

| user | name | stack | offers SR/SP/RC/RP/PI | proxies SR · SP · RC · RP · PI |
|---|---|---|---|---|
| 1 | `RamsesCommunicationUser_IC_HMI` | IC | 1/–/1/–/1 | – · 1,2,3,4,7 · – · 1,2,4,5,7 · 2,3,4,5,7 |
| 2 | `…Internal_HU_HMI` | HU | 2/1/4/1/2 | 1,3 · 2,3,4 · 1,5 · 2,4,5 · 1,3,4,5 |
| 3 | `…Internal_NAVI_HG` | HU | –/2/–/2/3 | 1,2,3 · – · 1,4,5 · – · 1,2,5 |
| 4 | `…Internal_NAVI_JV` | HU | –/3/–/4/4 | 1,2,3 · – · 1,4,5 · – · 1,2,5 |
| 5 | `…Internal_HU_SUA` | HU | –/7/–/7/7 | 1 · – · 1 · – · 1 |
| 101–110 | `…Internal_IC_Test1…10` | IC | 10+n in all five | 11–20 minus own |
| 199 | `…Internal_IC_Daemon` | IC | – | – |
| 201–210 | `…Internal_HU_Test1…10` | HU | 10+n in all five | 11–20 minus own |
| 299 | `…Internal_HU_Daemon` | HU | – | – |
| 401 / 402 | `…IC_LimitedInstances1/2` | IC | –/20/–/–/19 · –/–/–/–/20 | within 11–20 |
| 403 / 404 | `…IC_ParticipantInfoMismatch1/2` | IC | 19 · 20 in all five | 11–20 minus own, PI none |
| 501–504 | HU counterparts of 401–404 | HU | as 401–404 | as 401–404 |
| 801 | `…MGUTestUserConnectingToAll` | HU | 3/4/5/5/5 | 1,2,4 · 1,2,3,5 · 1,4,6 · 1,2,4,6 · 1,2,3,4,6 |
| 802 | `…MGUTestUserConnectingToAll_ICStack` | IC | 3/4/5/5/5 | as 801 |
| 803 | `…KombiTestUserConnectingOnlyToMGUTestUser` | IC | 4/5/6/6/6 | 3 · 4 · 5 · 5 · 5 |
| 901 | `…IC_HMI_Test` | IC | 11/–/11/–/11 | – · 14,15 · – · 14,15 · 14,15 |
| 902 | `…HU_HMI_Test` | HU | 14/14/14/14/14 | 11 · 15 · 11 · 15 · 11,15 |
| 903 | `…NAVI_Test` | HU | –/15/–/15/15 | 11,14 · – · 11,14 · – · 11,14 |

Any other value returns "Unknown communication user".

### TCP ports

The MGU's TCP ports for these instances (`vsomeip_gen.json`, VERIFIED):

| Service | instance → port |
|---|---|
| SceneRenderer | 2 → 32501, 3 → 32502 |
| SceneProvider | 1–4 → 32501–32504, 7 → 32513, 8 → 32514 |
| ResourceConsumer | 5 → 32502, 4 → 32504 |
| ResourceProvider | 1–5 → 32501–32505, 7 → 32513, 8 → 32514 |
| ParticipantInfo | 2–5 → 32501–32504, 7 → 32513, 8 → 32514 |

- Ports follow the instance, not the participant. INFERRED from vsomeip design: the routing manager owns these external endpoints, so participants sharing a port do not conflict.
- No instance 11 or higher is provisioned.
- No 19.0.14 user offers instance 8.

**RamsesService 0xB0BE is not used by this library:** no reference to it in `.rodata` or the import list (VERIFIED absence).

- From the table: SUA is instance 7, on port 32513; ports 32504/32505
  carry user 801's SceneProvider 4, ParticipantInfo 5 and ResourceProvider
  5, NAVI_JV's ResourceProvider 4 and HU_HMI's ResourceConsumer 4.

### Who uses which user on the unit

All callers of `enableSomeIPCommunication` in the unit's firmware (VERIFIED):

| Binary | User passed |
|---|---|
| HmiMain3D | HMI role 1 → **2 (HU_HMI)**, role 4 → **5 (HU_SUA)**; other roles: none |
| HmiDisplayClusterScenes | same as HmiMain3D |
| NavigationBasic | default 3 (NAVI_HG), config can change it |
| GeniviAdapter | value chosen at runtime ("ramsesAppId") |
| nv_md | value chosen at runtime |

INFERRED: GeniviAdapter and nv_md use the navi users. No binary passes 801.

### The service's user: 801

- 801 is on the HU stack; IC-stack users (1, 101–110, 401–404, 802, 803,
  901) fail in the MGU library ("compiled without useSomeIP_IC").
- Its own instances (SR3, SP4, RC5, RP5, PI5) belong to no other
  participant and are all in `vsomeip_gen.json` (ports above), and it
  proxies the KOMBI's IC_HMI instance 1 for SceneRenderer, ResourceConsumer
  and ParticipantInfo. IC_HMI's proxy lists include SP4, RP5 and PI5.
- HU_HMI proxies 801's instances too, so HmiMain3D sees its scenes as
  available: use scene ids HmiMain3D does not use.
- vsomeip security: offering and requesting 0xB05A–0xB05E is allowed for
  uid 5000 (`hmi_5000`) in both of the unit's policy files
  (`/etc/vsomeip/10017_902/` and `/etc/vsomeip/5000_5000/vsomeip_security.json`),
  so the service runs as uid/gid 5000.

## Differences from upstream 25

Upstream 25.0.0 is the same API family: enums with string tables have identical values. 19 differs here:

- **No `Scene::createNode`.** Use `createGroupNode` (`GroupNode : Node`). It supports all `Node` transform calls (smoke).
  - 19 also has `createTransformationNode`, `createTranslateNode`, `createRotateNode`, `createScaleNode` and `createVisibilityNode`; they are not declared.
- **`Node::setVisibility(bool)`** and `bool getVisibility()`, not `EVisibilityMode`.
- **Rotation:** `Node::setRotation(x, y, z)` only, with no rotation convention argument.
- **`Appearance::setDepthWrite(bool)`.** The getter is `getDepthWriteMode(EDepthWrite&)`.
- **`Appearance::setInputValueMatrix44f(input, const float*)`**, not `const float(&)[16]`.
- **One sampling method per sampler:**
  - `Scene::createTextureSampler(wrapU, wrapV, ETextureSamplingMethod, texture, anisotropy = 1, name)`. There is no separate min/mag.
  - Overloads exist and are declared for `Texture2D`, `Texture2DBuffer`, `RenderBuffer` (a canvas's colour buffer) and `TextureCube`. Texture3D and StreamTexture overloads exist but are not declared.
- **Sampling-method names:** Nearest 0, NearestWithMipmaps 1, Bilinear 2, BilinearWithMipMaps 3, Trilinear 4, MinLinearMagNearest 5, MinNearestMagLinear 6. **There is no `ETextureSamplingMethod_Linear`; use `_Bilinear`.**
- **`LocalCamera::setViewport(uint32_t x, uint32_t y, uint32_t w, uint32_t h)`**: x and y are unsigned.
- **Flush and publish:**
  - `Scene::flush(ESceneFlushMode = Synchronous, sceneVersionTag_t = InvalidSceneVersionTag)`. Only Synchronous (1) works.
  - `publish(EScenePublicationMode = LocalAndRemote)`.
  - `createScene(sceneId_t (uint64), const SceneConfig&, name)` has no default `SceneConfig`; pass one.
- **Construction:**
  - `new RamsesClient(name, framework)`, not `RamsesFramework::createClient`.
  - `new RamsesRenderer(framework, config)`, not `createRenderer`.
  - `RamsesFramework` is not a `StatusObject`.
- **`getStatusMessage(status)` is on `RamsesClient` and `RamsesRenderer`**, not on `StatusObject`.
- **Cache flag:** `resourceCacheFlag_t` is `StronglyTypedValue<uint32_t, resourceCacheFlagTag>`, with 2 template parameters. `ResourceCacheFlag_DoNotCache` = 0.
- **Renderer scene control** is on `RamsesRenderer`: `subscribeScene`, `mapScene(displayId, sceneId, order)`, `showScene`, `hideScene`, `unmapScene`, `unsubscribeScene`, then `flush()`. There is no `RendererSceneControl`.
- **`Effect` lookup:** only `findUniformInput(const char*, …)` / `findAttributeInput(const char*, …)`. There is no semantic-based overload.
- **Void returns:** `RamsesFrameworkConfig::setDLTApplicationID` / `setDLTApplicationDescription` / `setPeriodicLogsEnabled` and `RenderPass::getClearColor` return `void`.
- **Animation:** `AnimationSystem` is a `SceneObject` and `AnimationObject : SceneObject`. `AnimationSequence::addAnimation` takes `uint32_t` start and stop.

## DLT log levels

| Item | Evidence | Label |
|---|---|---|
| The library takes `dlt_register_log_level_changed_callback` from libdlt 2.15.0 at run time, so a definition in the executable comes first (`../src/ramses_dlt.h`) | `.dynsym`: an undefined import; of the unit's `/lib` and `/usr/lib` libraries no other imports it | VERIFIED |
| It passes a `DltContext *` whose first member is the 4-byte context id, and its callback sets the context's level, which gates the console and DLT alike; libdlt drops a message below the daemon's level itself | `make test-dlt` on the unit's dlt-daemon, libdlt and this library: the console quiet at the daemon's OFF without the wrapper, live with it; DLT gets the library's messages only at INFO either way | VERIFIED |

## Not reconstructed

- **Renderer events.** `RamsesRenderer::dispatchEvents(IRendererEventHandler&)` and `RamsesClient::dispatchEvents(IClientEventHandler&)` are not declared: their vtable order is not checked. A renderer built on these headers has to retry `subscribeScene`/`mapScene`/`showScene` instead of waiting for events. INFERRED: undispatched events queue up.
- **Not exercised:** `RamsesRenderer::createDisplay` and `doOneLoop`/`startThread`.
- **Undeclared:** `AttributeInput::getDataType`, and the values of `ERamsesObjectType` and `EEffectInputDataType` (learned at run time, above).

/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* A mesh layer: a client's 3D content, drawn in its own render pass over
 * params.rect with its own camera, at its place in the layer stack.
 *
 * It holds parts, each drawn by the client's shaders (part effect) with
 * geometry the client sends: immutable resources made once a geometry, not
 * per frame. A part's geometry may be replaced at most once a second; its
 * bytes spend the shared upload budget. Parts move by their pose, and by
 * animations the renderer plays itself; uniforms and asset binds are per
 * part. Everything is kept on the CPU, so a new scene gets it all again.
 * The layer is ready once a part has geometry. */
#ifndef CRS_MESH_LAYER_H
#define CRS_MESH_LAYER_H

#include <map>
#include <string>
#include <vector>

#include "layer.h"

namespace crs {

struct MeshParams {
    Projection projection;
    Pose camera;   /* position and rotation; its scale is not used */
};

/* A part's geometry as the client sent it. */
struct MeshData {
    uint32_t vertices = 0;
    std::vector<float> position, normal, texcoord, color;
    std::vector<uint16_t> index;

    /* The attributes it carries (kAttr* bits). */
    unsigned attributes() const;
    size_t bytes() const;
    Geometry geometry() const;
};

class MeshLayer : public Layer {
public:
    static const size_t kMaxParts = 16;
    static const int64_t kGeometryMs = 1000;

    MeshLayer(uint32_t id, int target, uint64_t seq, crk::UploadPacer &pacer, const MeshParams &mp);
    const char *kind() const override { return "mesh"; }

    /* The camera, applied by place() with params. */
    MeshParams mesh;

    /* Part number part (1 or more) drawn by effect, which reads attributes
     * (kAttr* bits), or with effect 0 a pivot, which draws nothing and which
     * parts follow; following parent, a part made before it (0: the view;
     * made before, so parents never loop). False with *err, and nothing
     * made, when it exists, past kMaxParts, its parent is not there, or the
     * renderer refuses it. */
    bool add_part(uint32_t part, int effect, unsigned attributes, const PartLook &look, uint32_t parent,
                  std::string *err);
    bool has_part(uint32_t part) const { return parts_.count(part) != 0; }
    /* Indices its parts draw (indices times instances), but part except's. */
    uint64_t drawn_indices(uint32_t except = 0) const;
    /* Bytes the part's geometry holds. */
    size_t part_bytes(uint32_t part) const;
    /* Replaces the part's geometry. False with *err when its index count
     * does not fit the part's draw mode, it lacks an attribute the part's
     * vertex shader reads, the part, the layer or (target_room: what the
     * target's other mesh layers leave) the target would draw past its
     * bound (graph.h kMaxPartIndices), or the part's last geometry came less
     * than kGeometryMs ago. */
    bool set_geometry(uint32_t part, MeshData &&data, int64_t now_ms, std::string *err,
                      uint64_t target_room);
    bool set_pose(uint32_t part, const Pose &p);
    /* The part's pose as the client set it. */
    Pose pose(uint32_t part) const;
    bool set_uniform(uint32_t part, const std::string &name, const float *v, int n);
    bool set_uniform(uint32_t part, const std::string &name, UniformType t, const float *v, uint32_t elements);
    /* The effects its parts are drawn by. */
    std::vector<int> effects() const;
    /* The part's effect; 0 for a pivot or no such part. */
    int part_effect(uint32_t part) const
    {
        auto it = parts_.find(part);
        return it == parts_.end() ? 0 : it->second.effect;
    }

    bool ready(int64_t now_ms) const override;
    bool attach(Graph *g, int64_t now_ms, std::string *err) override;
    void detach(bool drop) override;
    void arrange(bool drawn, int32_t order) override;
    void place() override;
    Stage stage(int64_t now_ms) override;
    void committed(bool ok, int64_t now_ms) override;
    size_t staged_bytes() const override { return staged_; }
    std::string stats() const override;
    int drawable(uint32_t part) const override;
    Uniforms *uniforms_of(uint32_t part) override
    {
        auto it = parts_.find(part);
        return it == parts_.end() ? nullptr : &it->second.uniforms;
    }
    std::string refusal() const override { return refusal_; }

protected:
    int animated(uint32_t part) const override { return part ? drawable(part) : view_; }
    const char *animation_error(uint32_t part, const Animation &a) const override;
    void restore(uint32_t part, const Animation &a) override;

private:
    struct Part {
        int effect = 0;
        unsigned attributes = 0;
        PartLook look;
        Pose pose;
        Uniforms uniforms;
        MeshData data;
        bool have = false;          /* the client sent geometry */
        bool upload = false;        /* the scene does not have it yet */
        int64_t geometry_ms = -1;   /* when it last came */
        int handle = 0;
        bool pivot = false;         /* draws nothing (add_part() with no effect) */
        uint32_t parent = 0;        /* the part it follows; 0: the view */
    };

    bool create(uint32_t number, Part &p);

    std::map<uint32_t, Part> parts_;
    int view_ = 0;
    size_t staged_ = 0;   /* geometry bytes this tick */
    std::string refusal_;
    uint64_t uploads_ = 0, upload_bytes_ = 0;
};

}  // namespace crs

#endif

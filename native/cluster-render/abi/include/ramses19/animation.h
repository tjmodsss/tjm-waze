// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Robert Nisipeanu
// Declares the API of RAMSES (https://github.com/bmwcarit/ramses), BMW Car IT GmbH, MPL-2.0.
// Animation system for libramses 19.0.14.
#ifndef RAMSES19_ANIMATION_H
#define RAMSES19_ANIMATION_H

#include "scene.h"

namespace ramses
{
    class AnimationObject : public SceneObject { public: RAMSES19_LIBRARY_OWNED(AnimationObject); };

    class AnimatedProperty : public AnimationObject { public: RAMSES19_LIBRARY_OWNED(AnimatedProperty); };

    class Spline : public AnimationObject
    {
    public:
        uint32_t getNumberOfKeys() const;
        RAMSES19_LIBRARY_OWNED(Spline);
    };

    class SplineLinearFloat : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float value);
        RAMSES19_LIBRARY_OWNED(SplineLinearFloat);
    };

    class SplineLinearVector3f : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float x, float y, float z);
        RAMSES19_LIBRARY_OWNED(SplineLinearVector3f);
    };

    class SplineLinearVector4f : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float x, float y, float z, float w);
        RAMSES19_LIBRARY_OWNED(SplineLinearVector4f);
    };

    class SplineStepFloat : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float value);
        RAMSES19_LIBRARY_OWNED(SplineStepFloat);
    };

    class SplineStepVector3f : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float x, float y, float z);
        RAMSES19_LIBRARY_OWNED(SplineStepVector3f);
    };

    class SplineStepVector4f : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float x, float y, float z, float w);
        RAMSES19_LIBRARY_OWNED(SplineStepVector4f);
    };

    class SplineBezierFloat : public Spline
    {
    public:
        status_t setKey(splineTimeStamp_t timeStamp, float value,
                        float tanInX, float tanInY, float tanOutX, float tanOutY);
        RAMSES19_LIBRARY_OWNED(SplineBezierFloat);
    };

    class Animation : public AnimationObject
    {
    public:
        globalTimeStamp_t getStartTime() const;
        globalTimeStamp_t getStopTime() const;
        RAMSES19_LIBRARY_OWNED(Animation);
    };

    class AnimationSequence : public AnimationObject
    {
    public:
        status_t addAnimation(const Animation& animation, sequenceTimeStamp_t startTimeInSequence = 0u,
                              sequenceTimeStamp_t stopTimeInSequence = 0u);
        status_t removeAnimation(const Animation& animation);
        bool containsAnimation(const Animation& animation) const;
        status_t setAnimationLooping(const Animation& animation, timeMilliseconds_t loopDuration = 0);
        status_t setAnimationRelative(const Animation& animation);
        status_t setAnimationAbsolute(const Animation& animation);
        status_t setPlaybackSpeed(float playbackSpeed);
        float getPlaybackSpeed() const;
        // the latest stop time of its animations, in sequence time
        sequenceTimeStamp_t getAnimationSequenceStopTime() const;
        status_t start(timeMilliseconds_t offset = 0);
        status_t startAt(globalTimeStamp_t timeStamp);
        status_t startReverse(timeMilliseconds_t offset = 0);
        status_t startReverseAt(globalTimeStamp_t timeStamp);
        status_t stop(timeMilliseconds_t delay = 0);
        status_t stopAt(globalTimeStamp_t timeStamp);
        uint32_t getNumberOfAnimations() const;
        RAMSES19_LIBRARY_OWNED(AnimationSequence);
    };

    class AnimationSystem : public SceneObject
    {
    public:
        AnimatedProperty* createAnimatedProperty(const Node& node, EAnimatedProperty property,
                                                 EAnimatedPropertyComponent propertyComponent = EAnimatedPropertyComponent_All,
                                                 const char* name = nullptr);
        AnimatedProperty* createAnimatedProperty(const UniformInput& propertyOwner, const Appearance& appearance,
                                                 EAnimatedPropertyComponent propertyComponent = EAnimatedPropertyComponent_All,
                                                 const char* name = nullptr);
        AnimatedProperty* createAnimatedProperty(const DataObject& dataObject,
                                                 EAnimatedPropertyComponent propertyComponent = EAnimatedPropertyComponent_All,
                                                 const char* name = nullptr);
        Animation* createAnimation(const AnimatedProperty& animatedProperty, const Spline& spline, const char* name = nullptr);
        AnimationSequence* createAnimationSequence(const char* name = nullptr);
        SplineLinearFloat* createSplineLinearFloat(const char* name = nullptr);
        SplineLinearVector3f* createSplineLinearVector3f(const char* name = nullptr);
        SplineLinearVector4f* createSplineLinearVector4f(const char* name = nullptr);
        SplineStepFloat* createSplineStepFloat(const char* name = nullptr);
        SplineStepVector3f* createSplineStepVector3f(const char* name = nullptr);
        SplineStepVector4f* createSplineStepVector4f(const char* name = nullptr);
        SplineBezierFloat* createSplineBezierFloat(const char* name = nullptr);
        status_t destroy(AnimationObject& animationObject);
        // its animation objects are its own, not the scene's (Scene::findObjectByName)
        RamsesObject* findObjectByName(const char* name);
        status_t setTime(globalTimeStamp_t timeStamp);
        globalTimeStamp_t getTime() const;
        RAMSES19_LIBRARY_OWNED(AnimationSystem);
    };

    class AnimationSystemRealTime : public AnimationSystem
    {
    public:
        // systemTime in milliseconds; 0 takes the current system time.
        status_t updateLocalTime(globalTimeStamp_t systemTime = 0u);
        RAMSES19_LIBRARY_OWNED(AnimationSystemRealTime);
    };
}

#endif

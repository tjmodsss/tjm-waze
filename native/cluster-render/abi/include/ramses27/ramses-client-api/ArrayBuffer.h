//  -------------------------------------------------------------------------
//  Copyright (C) 2020 BMW AG
//  -------------------------------------------------------------------------
//  This Source Code Form is subject to the terms of the Mozilla Public
//  License, v. 2.0. If a copy of the MPL was not distributed with this
//  file, You can obtain one at https://mozilla.org/MPL/2.0/.
//  -------------------------------------------------------------------------

#ifndef RAMSES_ARRAYBUFFER_H
#define RAMSES_ARRAYBUFFER_H

#include "ramses-client-api/SceneObject.h"
#include "ramses-client-api/EDataType.h"

namespace ramses
{
    class RAMSES_API ArrayBuffer : public SceneObject
    {
    public:
        status_t updateData(uint32_t firstElement, uint32_t numElements, const void* bufferData);

        uint32_t getMaximumNumberOfElements() const;

        uint32_t getUsedNumberOfElements() const;

        EDataType getDataType() const;

        status_t getData(void* buffer, uint32_t numElements) const;

        class ArrayBufferImpl& impl;

    protected:
        friend class RamsesObjectRegistry;

        explicit ArrayBuffer(ArrayBufferImpl& pimpl);

        virtual ~ArrayBuffer();
    };
}

#endif

import { ExtensionType } from '../../../extensions/Extensions';
import { Buffer } from '../shared/buffer/Buffer';
import { BufferResource } from '../shared/buffer/BufferResource';
import { BufferUsage } from '../shared/buffer/const';
import { UboBatch } from './buffer/UboBatch';
import { BindGroup } from './shader/BindGroup';

import type { UniformGroup } from '../shared/shader/UniformGroup';
import type { WebGPURenderer } from './WebGPURenderer';

const minUniformOffsetAlignment = 256;

/** @internal */
export class GpuUniformBatchPipe
{
    /** @ignore */
    public static extension = {
        type: [
            ExtensionType.WebGPUPipes,
        ],
        name: 'uniformBatch',
    } as const;

    private _renderer: WebGPURenderer;

    private _bindGroupHash: Record<number, BindGroup> = Object.create(null);
    private readonly _batchBuffer: UboBatch;

    private readonly _buffer: Buffer;

    private _bindGroups: BindGroup[] = [];
    private _bufferResources: BufferResource[] = [];

    constructor(renderer: WebGPURenderer)
    {
        this._renderer = renderer;

        // Aligned records share one upload; shifted copies require another queue submission.
        this._batchBuffer = new UboBatch({ minUniformOffsetAlignment, capacity: 65535 * 2 });
        this._buffer = new Buffer({
            data: this._batchBuffer.data,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
    }

    public renderEnd()
    {
        try
        {
            this._uploadBindGroups();
        }
        finally
        {
            this._resetBindGroups();
        }
    }

    private _resetBindGroups()
    {
        this._bindGroupHash = Object.create(null);
        this._batchBuffer.clear();
    }

    // just works for single bind groups for now
    public getUniformBindGroup(group: UniformGroup<any>, duplicate: boolean): BindGroup
    {
        if (!duplicate && this._bindGroupHash[group.uid])
        {
            return this._bindGroupHash[group.uid];
        }

        this._renderer.ubo.ensureUniformGroup(group);

        const data = group.buffer.data as Float32Array;

        const offset = this._batchBuffer.addEmptyGroup(data.length);

        this._renderer.ubo.syncUniformGroup(group, this._batchBuffer.data, offset / 4);

        this._bindGroupHash[group.uid] = this._getBindGroup(offset / minUniformOffsetAlignment);

        return this._bindGroupHash[group.uid];
    }

    public getUboResource(group: UniformGroup<any>): BufferResource
    {
        this._renderer.ubo.updateUniformGroup(group);

        const data = group.buffer.data as Float32Array;

        const offset = this._batchBuffer.addGroup(data);

        return this._getBufferResource(offset / minUniformOffsetAlignment);
    }

    public getArrayBindGroup(data: Float32Array): BindGroup
    {
        const offset = this._batchBuffer.addGroup(data);

        return this._getBindGroup(offset / minUniformOffsetAlignment);
    }

    public getArrayBufferResource(data: Float32Array): BufferResource
    {
        const offset = this._batchBuffer.addGroup(data);

        const index = offset / minUniformOffsetAlignment;

        return this._getBufferResource(index);
    }

    private _getBufferResource(index: number): BufferResource
    {
        if (!this._bufferResources[index])
        {
            this._bufferResources[index] = new BufferResource({
                buffer: this._buffer,
                offset: index * minUniformOffsetAlignment,
                size: minUniformOffsetAlignment
            });
        }

        return this._bufferResources[index];
    }

    private _getBindGroup(index: number): BindGroup
    {
        if (!this._bindGroups[index])
        {
            // even!
            const bindGroup = new BindGroup({
                0: this._getBufferResource(index),
            });

            this._bindGroups[index] = bindGroup;
        }

        return this._bindGroups[index];
    }

    private _uploadBindGroups()
    {
        if (!this._batchBuffer.byteIndex) return;

        this._buffer.update(this._batchBuffer.byteIndex);
        this._renderer.buffer.updateBuffer(this._buffer);
    }

    public destroy()
    {
        for (let i = 0; i < this._bindGroups.length; i++)
        {
            this._bindGroups[i]?.destroy();
        }

        this._bindGroups = null;
        this._bindGroupHash = null;

        this._buffer.destroy();

        for (let i = 0; i < this._bufferResources.length; i++)
        {
            this._bufferResources[i].destroy();
        }

        this._bufferResources = null;

        this._batchBuffer.destroy();

        this._renderer = null;
    }
}

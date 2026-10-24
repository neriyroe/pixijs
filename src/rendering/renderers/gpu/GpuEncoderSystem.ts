import { ExtensionType } from '../../../extensions/Extensions';
import { warn } from '../../../utils/logging/warn';
import { type ShaderOverrides } from '../shared/shader/ShaderOverrides';
import { RenderBundle } from './RenderBundle';

import type { Rectangle } from '../../../maths/shapes/Rectangle';
import type { Buffer } from '../shared/buffer/Buffer';
import type { Topology } from '../shared/geometry/const';
import type { Geometry } from '../shared/geometry/Geometry';
import type { Shader } from '../shared/shader/Shader';
import type { UniformGroup } from '../shared/shader/UniformGroup';
import type { State } from '../shared/state/State';
import type { System } from '../shared/system/System';
import type { GPU } from './GpuDeviceSystem';
import type { GpuRenderTarget } from './renderTarget/GpuRenderTarget';
import type { BindGroup } from './shader/BindGroup';
import type { GpuProgram } from './shader/GpuProgram';
import type { WebGPURenderer } from './WebGPURenderer';

interface BoundBindGroupSlot
{
    bindGroup: BindGroup;
    program: GpuProgram;
    key: string;
}

type PassState = Pick<GPURenderPassEncoder, 'setViewport' | 'setScissorRect' | 'setStencilReference'>;

/** The pass-level state a deferred pass is given before it begins, replayed onto the pass once it does. @internal */
class DeferredPassState implements PassState
{
    private readonly _viewport = new Float64Array(6);
    private readonly _scissor = new Float64Array(4);
    private _stencilReference = 0;
    private _hasViewport = false;
    private _hasScissor = false;
    private _hasStencilReference = false;

    public setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void
    {
        const viewport = this._viewport;

        viewport[0] = x;
        viewport[1] = y;
        viewport[2] = width;
        viewport[3] = height;
        viewport[4] = minDepth;
        viewport[5] = maxDepth;
        this._hasViewport = true;
    }

    public setScissorRect(x: number, y: number, width: number, height: number): void
    {
        const scissor = this._scissor;

        scissor[0] = x;
        scissor[1] = y;
        scissor[2] = width;
        scissor[3] = height;
        this._hasScissor = true;
    }

    public setStencilReference(reference: number): void
    {
        this._stencilReference = reference;
        this._hasStencilReference = true;
    }

    public replay(pass: GPURenderPassEncoder): void
    {
        const viewport = this._viewport;
        const scissor = this._scissor;

        if (this._hasViewport)
        {
            pass.setViewport(viewport[0], viewport[1], viewport[2], viewport[3], viewport[4], viewport[5]);
        }

        if (this._hasScissor) pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
        if (this._hasStencilReference) pass.setStencilReference(this._stencilReference);
    }

    public reset(): void
    {
        this._hasViewport = this._hasScissor = this._hasStencilReference = false;
    }
}

/**
 * The system that handles encoding commands for the GPU.
 * @category rendering
 * @advanced
 */
export class GpuEncoderSystem implements System
{
    /** @ignore */
    public static extension = {
        type: [ExtensionType.WebGPUSystem],
        name: 'encoder',
        priority: 1
    } as const;

    public commandEncoder: GPUCommandEncoder;
    public commandFinished: Promise<void>;

    private _resolveCommandFinished: (value: void) => void;

    private _gpu: GPU;
    /**
     * Per-slot cache of the last (bindGroup, program, resource-key) bound to that
     * group index. All three prongs must match for the encoder to skip rebinding —
     * see {@link setBindGroup}. Slots are allocated once in the constructor and
     * mutated in place to avoid per-call allocation on the hot path.
     */
    private _boundBindGroup: Record<number, BoundBindGroupSlot> = Object.create(null);
    private _boundVertexBuffer: Record<number, Buffer> = Object.create(null);
    private _boundIndexBuffer: Buffer;
    private _boundPipeline: GPURenderPipeline;
    /**
     * The real render pass encoder. Unlike {@link renderPassEncoder}, this is never swapped out for
     * a bundle encoder, so pass-level commands (viewport, stencil, executeBundles, end) always have
     * a correctly typed target — even while a bundle is being recorded.
     */
    private _passEncoder: GPURenderPassEncoder = null;
    /** What {@link renderPassEncoder} returns while a pass is open: the pass, or a bundle encoder recording into it. */
    private _commands: GPURenderPassEncoder | GPURenderBundleEncoder = null;
    /** The target whose pass waits for its first command; it only loads and stores, so it may never begin. */
    private _deferred: GpuRenderTarget = null;
    private readonly _deferredState = new DeferredPassState();
    /**
     * {@link PipelineSystem.bundleStateKey} as it was when {@link beginBundle} built the bundle
     * encoder's descriptor, ready to stamp onto the {@link RenderBundle} that {@link endBundle}
     * returns. Sampled at that moment so the stamp and the state the bundle actually baked cannot
     * describe different render targets.
     */
    private _bundleStateKey: number;
    /** The label passed to {@link beginBundle}, carried through to the finished bundle. */
    private _bundleLabel: string;

    private readonly _renderer: WebGPURenderer;

    constructor(renderer: WebGPURenderer)
    {
        this._renderer = renderer;

        for (let i = 0; i < 16; i++)
        {
            this._boundBindGroup[i] = { bindGroup: null, program: null, key: null };
        }
    }

    /**
     * The active command target that draws and state are recorded into. This is the live render
     * pass during normal rendering, or a {@link GPURenderBundleEncoder} while a render bundle is
     * being recorded (see {@link beginBundle}). Both encoders expose the same render/bind command
     * API the encoder relies on (`GPURenderCommandsMixin` + `GPUBindingCommandsMixin`),
     * so callers write to it without caring which one is active. Pass-level commands (viewport,
     * stencil, executeBundles, end) are not part of that shared API and go through the private pass encoder.
     * Reading it begins a pass deferred to its first command (see {@link deferRenderPass}).
     */
    public get renderPassEncoder(): GPURenderPassEncoder | GPURenderBundleEncoder
    {
        return this._commands ?? this._openDeferred();
    }

    public set renderPassEncoder(encoder: GPURenderPassEncoder | GPURenderBundleEncoder)
    {
        this._commands = encoder;
    }

    /** Whether a pass is bound, begun or deferred to its first command. */
    public get hasRenderPass(): boolean
    {
        return !!(this._passEncoder || this._deferred);
    }

    public renderStart(): void
    {
        this.commandFinished = new Promise((resolve) =>
        {
            this._resolveCommandFinished = resolve;
        });

        // generate a render pass description..
        // create an encoder..
        this.commandEncoder = this._renderer.gpu.device.createCommandEncoder();
    }

    /**
     * Ends any open pass and begins one on the target's descriptor.
     * @param gpuRenderTarget - the target to render to
     * @returns the begun pass
     */
    public beginRenderPass(gpuRenderTarget: GpuRenderTarget): GPURenderPassEncoder
    {
        this.endRenderPass();

        this._clearCache();

        this._passEncoder = this.commandEncoder.beginRenderPass(gpuRenderTarget.descriptor);
        this.renderPassEncoder = this._passEncoder;

        return this._passEncoder;
    }

    // Ends any open pass and binds the target's, to begin at the first command that needs it. Its descriptor must only
    // load and store, as a pass nothing draws in is then dropped.
    public deferRenderPass(gpuRenderTarget: GpuRenderTarget): void
    {
        this.endRenderPass();
        this._clearCache();
        this._deferredState.reset();
        this._deferred = gpuRenderTarget;
    }

    public endRenderPass()
    {
        if (this._passEncoder)
        {
            this._passEncoder.end();
        }

        this.renderPassEncoder = null;
        this._passEncoder = null;
        this._deferred = null;
    }

    /**
     * Begins recording a render bundle. While recording, all draw commands are captured into a
     * {@link GPURenderBundleEncoder} instead of the active render pass. The current render pass
     * encoder is saved and restored when {@link endBundle} is called.
     *
     * Render bundles allow pre-recording of draw commands that can be replayed multiple times
     * via {@link executeBundle}, reducing CPU overhead for repeated draw sequences.
     * @param label - Optional debug label. Names the bundle in GPU captures and in the WebGPU
     * validation errors it can raise when replayed, instead of `(unlabeled)`.
     * @throws If a render bundle is already being recorded.
     */
    public beginBundle(label?: string): void
    {
        // While a bundle is recording, renderPassEncoder is swapped to the bundle encoder and no
        // longer matches the real pass. Equal references therefore mean no bundle is active.
        if (this._passEncoder !== this._commands)
        {
            throw new Error('Cannot begin a new render bundle while one is already being recorded.');
        }

        this._clearCache();

        const pipeline = this._renderer.pipeline;
        const descriptor = pipeline.getBundleDescriptor();

        descriptor.label = label;

        this._bundleStateKey = pipeline.bundleStateKey;
        this._bundleLabel = label;

        // A bundle encoder exposes the same render/bind command API as the pass, so it stands in as
        // the write target while recording. The real pass stays in _passEncoder and is restored by
        // endBundle.
        this.renderPassEncoder = this._gpu.device.createRenderBundleEncoder(descriptor);
    }

    /**
     * Finishes recording the current render bundle and restores the previous render pass encoder.
     * @returns The recorded {@link RenderBundle}, ready to be executed via {@link executeBundle} and
     * stamped with the pipeline state it baked so {@link isBundleValid} can vet it on later frames.
     */
    public endBundle(): RenderBundle
    {
        const encoder = this._commands;

        // `finish` only exists on a bundle encoder, so it both narrows the type for the call below
        // and guards against endBundle being called without an active bundle.
        if (!encoder || !('finish' in encoder))
        {
            throw new Error('endBundle called without an active render bundle.');
        }

        // the label goes on the bundle as well as on its encoder: WebGPU names the bundle, not the
        // encoder, in the validation error executeBundles raises
        const gpuBundle = encoder.finish({ label: this._bundleLabel });

        this.renderPassEncoder = this._passEncoder;
        this._clearCache();

        return new RenderBundle(gpuBundle, this._bundleStateKey, this._gpu.device, this._bundleLabel);
    }

    /**
     * Checks whether a recorded bundle can still be replayed against the render target that is
     * bound now.
     *
     * A bundle permanently bakes the attachment state it was recorded with — color format(s),
     * color target count, depth/stencil format, sample count — and WebGPU rejects the entire
     * command buffer if any of it differs at execute time. It also bakes the front-face winding of
     * its pipelines, which WebGPU does *not* validate: once the target's {@link RenderTarget.flipY}
     * parity changes, replaying silently renders geometry inside out.
     *
     * Ask before replaying rather than after: only the caller owns the draw commands, so only the
     * caller can re-record. A missing bundle reports `false`, so `!isBundleValid(bundles[i])` reads
     * correctly on the first frame, before anything has been recorded.
     * @param bundle - The bundle to check, as returned by {@link endBundle}.
     * @returns `true` if the bundle is safe to execute right now, `false` if it must be re-recorded.
     */
    public isBundleValid(bundle: RenderBundle): boolean
    {
        return bundle?.stateKey === this._renderer.pipeline.bundleStateKey && bundle.device === this._gpu.device;
    }

    /**
     * Replays previously recorded render bundles on the current render pass.
     * The bound state cache is cleared since a bundle may set its own pipeline, bind groups, and buffers.
     *
     * Pass a whole run of bundles rather than calling this once per bundle: WebGPU resets the pass
     * state after every call, so N calls cost N cache clears and N trips through the binding layer
     * for exactly the same result.
     *
     * Every bundle must have been recorded against a matching render target — check with
     * {@link isBundleValid} first and re-record if it says no, as Pixi cannot rebuild your draw
     * commands for you.
     * @param bundle - The render bundle to execute, or a run of them to execute in one call.
     */
    public executeBundle(bundle: RenderBundle | RenderBundle[]): void
    {
        const gpuBundles: GPURenderBundle[] = [];

        if (Array.isArray(bundle))
        {
            for (let i = 0; i < bundle.length; i++)
            {
                gpuBundles[i] = this._getGpuBundle(bundle[i]);
            }
        }
        else
        {
            gpuBundles[0] = this._getGpuBundle(bundle);
        }

        const pass = this._passEncoder ?? this._openDeferred();

        this._clearCache();
        pass.executeBundles(gpuBundles);
    }

    /**
     * Unwraps a bundle for {@link executeBundle}, complaining first if it no longer matches the
     * bound render target — the winding half of that mismatch is invisible otherwise, since WebGPU
     * validates attachments but not front-face order.
     * @param bundle - The bundle being executed.
     * @returns The native bundle to hand to `executeBundles`.
     */
    private _getGpuBundle(bundle: RenderBundle): GPURenderBundle
    {
        // #if _DEBUG
        if (!this.isBundleValid(bundle))
        {
            warn(`Render bundle ${bundle?.label ?? '(unlabeled)'} was recorded against a different render `
                + 'target state or on a lost device. Re-record it — replaying it will either be rejected by WebGPU or draw '
                + 'with the wrong winding. Check encoder.isBundleValid(bundle) before executing.');
        }
        // #endif

        return bundle.gpuBundle;
    }

    public setViewport(viewport: Rectangle): void
    {
        this._passState.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
    }

    /** Clips the pass's draws to `rect`, in pixels; pass-level state, so it targets the real pass, never a bundle. */
    public setScissorRect(rect: Rectangle): void
    {
        this._passState.setScissorRect(rect.x, rect.y, rect.width, rect.height);
    }

    /**
     * Sets the stencil reference value for subsequent draws. This is a pass-level command, so it
     * always targets the real render pass — not a bundle encoder, which cannot set stencil state.
     * @param stencilReference - The stencil reference value to use.
     */
    public setStencilReference(stencilReference: number): void
    {
        this._passState.setStencilReference(stencilReference);
    }

    /** Where pass-level state goes: the open pass, or the record a deferred pass replays when it begins. */
    private get _passState(): PassState
    {
        return this._passEncoder ?? this._deferredState;
    }

    // Begins the deferred pass, giving it the pass-level state set while it waited; null when no pass is bound.
    private _openDeferred(): GPURenderPassEncoder
    {
        const deferred = this._deferred;

        if (!deferred) return null;

        this.beginRenderPass(deferred);
        this._deferredState.replay(this._passEncoder);

        return this._passEncoder;
    }

    public setPipelineFromGeometryProgramAndState(
        geometry: Geometry,
        program: GpuProgram,
        state: any,
        topology?: Topology,
        overrides?: ShaderOverrides,
    ): void
    {
        const pipeline = this._renderer.pipeline.getPipeline(
            geometry,
            program,
            state,
            topology,
            overrides,
        );

        this.setPipeline(pipeline);
    }

    public setPipeline(pipeline: GPURenderPipeline)
    {
        if (this._boundPipeline === pipeline) return;
        this._boundPipeline = pipeline;

        this.renderPassEncoder.setPipeline(pipeline);
    }

    private _setVertexBuffer(index: number, buffer: Buffer)
    {
        if (this._boundVertexBuffer[index] === buffer) return;

        this._boundVertexBuffer[index] = buffer;

        this.renderPassEncoder.setVertexBuffer(index, this._renderer.buffer.updateBuffer(buffer));
    }

    private _setIndexBuffer(buffer: Buffer)
    {
        if (this._boundIndexBuffer === buffer) return;

        this._boundIndexBuffer = buffer;

        const indexFormat = buffer.data.BYTES_PER_ELEMENT === 2 ? 'uint16' : 'uint32';

        this.renderPassEncoder.setIndexBuffer(this._renderer.buffer.updateBuffer(buffer), indexFormat);
    }

    public resetBindGroup(index: number)
    {
        const slot = this._boundBindGroup[index];

        slot.bindGroup = null;
        slot.program = null;
        slot.key = null;
    }

    public setBindGroup(index: number, bindGroup: BindGroup, program: GpuProgram)
    {
        // The cached GPUBindGroup is only valid when the JS BindGroup, the program
        // (its layout key), and the BindGroup's resource set (its _key) are all unchanged.
        // BindGroupSystem interns one GPUBindGroup per (bindGroup, program, groupIndex),
        // so if any prong differs we must re-resolve and rebind.
        const slot = this._boundBindGroup[index];

        if (slot.bindGroup === bindGroup
            && slot.program === program
            && slot.key === bindGroup._key) return;

        slot.bindGroup = bindGroup;
        slot.program = program;
        slot.key = bindGroup._key;

        bindGroup._touch(this._renderer.gc.now);

        const gpuBindGroup = this._renderer.bindGroup.getBindGroup(bindGroup, program, index);

        this.renderPassEncoder.setBindGroup(index, gpuBindGroup);
    }

    public setGeometry(geometry: Geometry, program: GpuProgram)
    {
        // when binding a buffers for geometry, there is no need to bind a buffer more than once if it is interleaved.
        // which is often the case for Pixi. This is a performance optimisation.
        // Instead of looping through the attributes, we instead call getBufferNamesToBind
        // which returns a list of buffer names that need to be bound.
        // we can then loop through this list and bind the buffers.
        // essentially only binding a single time for any buffers that are interleaved.
        const buffersToBind = this._renderer.pipeline.getBufferNamesToBind(geometry, program);

        for (let i = 0; i < buffersToBind.length; i++)
        {
            this._setVertexBuffer(i, geometry.attributes[buffersToBind[i]].buffer);
        }

        if (geometry.indexBuffer)
        {
            this._setIndexBuffer(geometry.indexBuffer);
        }
    }

    private _setShaderBindGroups(shader: Shader, skipSync?: boolean)
    {
        const program = shader.gpuProgram;
        const layout = program.layout;

        // indexed over the layout so no key list is built per draw. Groups outside the layout
        // (e.g. GL-fallback uniforms, parked in group 99 by Shader.from) have nothing to sync or bind
        for (let i = 0; i < layout.length; i++)
        {
            const bindGroup = shader.groups[i];

            // a gap in a sparse layout, or a group this shader never filled
            if (!layout[i] || !bindGroup) continue;

            // update any uniforms?
            if (!skipSync)
            {
                this._syncBindGroup(bindGroup);
            }

            this.setBindGroup(i, bindGroup, program);
        }
    }

    private _syncBindGroup(bindGroup: BindGroup)
    {
        const resources = bindGroup.resources;
        const keys = bindGroup._resourceKeys;

        for (let i = 0; i < keys.length; i++)
        {
            const resource = resources[keys[i]];

            // a destroyed buffer-like resource leaves a null slot (see BindGroup.onResourceChange)
            if (!resource) continue;

            if ((resource as UniformGroup).isUniformGroup)
            {
                this._renderer.ubo.updateUniformGroup(resource as UniformGroup);
            }
        }
    }

    public draw(options: {
        geometry: Geometry;
        shader: Shader;
        state?: State;
        topology?: Topology;
        size?: number;
        start?: number;
        baseVertex?: number;
        instanceCount?: number;
        skipSync?: boolean;
        firstInstance?: number;
    })
    {
        const { geometry, shader, state, topology, size, start, baseVertex, instanceCount, skipSync, firstInstance }
            = options;

        this.setPipelineFromGeometryProgramAndState(geometry, shader.gpuProgram, state, topology, shader._overrides);
        this.setGeometry(geometry, shader.gpuProgram);
        this._setShaderBindGroups(shader, skipSync);

        if (geometry.indexBuffer)
        {
            this.renderPassEncoder.drawIndexed(
                size || geometry.indexCount || geometry.indexBuffer.data.length,
                instanceCount ?? geometry.instanceCount,
                start || 0,
                baseVertex || 0,
                firstInstance || 0
            );
        }
        else
        {
            this.renderPassEncoder.draw(
                size || geometry.vertexCount,
                instanceCount ?? geometry.instanceCount,
                start || 0,
                firstInstance || 0
            );
        }
    }

    /**
     * Sets up the pipeline, geometry, and bind groups then issues an indirect draw call.
     * Uses `drawIndexedIndirect` when the geometry has an index buffer, otherwise `drawIndirect`.
     * Draw parameters (vertex count, instance count, etc.) are read from the indirect buffer on the GPU.
     * @param options - The draw options.
     * @param options.geometry - The geometry to draw.
     * @param options.shader - The shader to use.
     * @param options.state - Optional render state (blending, depth, etc.).
     * @param options.topology - Optional primitive topology override.
     * @param options.skipSync - If true, skips syncing uniform groups to their GPU buffers.
     * @param options.indirectBuffer - The GPU buffer containing the indirect draw parameters.
     * @param options.indirectOffset - Byte offset into the indirect buffer.
     */
    public drawIndirect(options: {
        geometry: Geometry;
        shader: Shader;
        state?: State;
        topology?: Topology;
        skipSync?: boolean;
        indirectBuffer: GPUBuffer;
        indirectOffset: number;
    })
    {
        const { geometry, shader, state, topology, skipSync, indirectBuffer, indirectOffset } = options;

        this.setPipelineFromGeometryProgramAndState(geometry, shader.gpuProgram, state, topology, shader._overrides);
        this.setGeometry(geometry, shader.gpuProgram);
        this._setShaderBindGroups(shader, skipSync);

        if (geometry.indexBuffer)
        {
            this.renderPassEncoder.drawIndexedIndirect(indirectBuffer, indirectOffset);
        }
        else
        {
            this.renderPassEncoder.drawIndirect(indirectBuffer, indirectOffset);
        }
    }

    public finishRenderPass()
    {
        this._deferred = null;

        if (this._passEncoder)
        {
            this._passEncoder.end();
            this.renderPassEncoder = null;
            this._passEncoder = null;
        }
    }

    public postrender()
    {
        this.finishRenderPass();

        this.submit([this.commandEncoder.finish()]);

        this._resolveCommandFinished();

        this.commandEncoder = null;
    }

    /**
     * @param commands - The recorded command buffers to submit.
     * @internal
     */
    public submit(commands: GPUCommandBuffer[]): void
    {
        this._gpu.device.queue.submit(commands);
    }

    private _clearCache()
    {
        for (let i = 0; i < 16; i++)
        {
            const slot = this._boundBindGroup[i];

            slot.bindGroup = null;
            slot.program = null;
            slot.key = null;
            this._boundVertexBuffer[i] = null;
        }

        this._boundIndexBuffer = null;
        this._boundPipeline = null;
    }

    public destroy()
    {
        (this._renderer as null) = null;
        this._gpu = null;
        this._boundBindGroup = null;
        this._boundVertexBuffer = null;
        this._boundIndexBuffer = null;
        this._boundPipeline = null;
        this.renderPassEncoder = null;
        this._passEncoder = null;
        this._deferred = null;
    }

    protected contextChange(gpu: GPU): void
    {
        this._gpu = gpu;
    }
}

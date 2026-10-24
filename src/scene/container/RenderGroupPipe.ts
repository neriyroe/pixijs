import { ExtensionType } from '../../extensions/Extensions';
import { type Renderer } from '../../rendering/renderers/types';
import { BigPool } from '../../utils/pool/PoolGroup';
import { BatchableSprite } from '../sprite/BatchableSprite';
import { executeInstructions } from './utils/executeInstructions';

import type { PointData } from '../../maths/point/PointData';
import type { InstructionSet } from '../../rendering/renderers/shared/instructions/InstructionSet';
import type { InstructionPipe } from '../../rendering/renderers/shared/instructions/RenderPipe';
import type { BindOptions } from '../../rendering/renderers/shared/renderTarget/RenderTargetSystem';
import type { RenderGroup } from './RenderGroup';

/**
 * The RenderGroupPipe is a render pipe for rendering RenderGroups.
 * @internal
 */
export class RenderGroupPipe implements InstructionPipe<RenderGroup>
{
    public static extension = {
        type: [
            ExtensionType.WebGLPipes,
            ExtensionType.WebGPUPipes,
            ExtensionType.CanvasPipes,
        ],
        name: 'renderGroup',
    } as const;

    private _renderer: Renderer;
    private readonly _origin: PointData = { x: 0, y: 0 };
    private readonly _binding: BindOptions = { target: null, clear: true, frame: null };
    private readonly _stale: RenderGroup[] = [];

    constructor(renderer: Renderer)
    {
        this._renderer = renderer;
    }

    public addRenderGroup(renderGroup: RenderGroup, instructionSet: InstructionSet): void
    {
        if (renderGroup.isCachedAsTexture)
        {
            this._addRenderableCacheAsTexture(renderGroup, instructionSet);
        }
        else
        {
            this._addRenderableDirect(renderGroup, instructionSet);
        }
    }

    public execute(renderGroup: RenderGroup)
    {
        if (!renderGroup.isRenderable) return;

        if (renderGroup.isCachedAsTexture)
        {
            this._executeCacheAsTexture(renderGroup);
        }
        else
        {
            this._executeDirect(renderGroup);
        }
    }

    public destroy(): void
    {
        this._renderer = null;
        this._stale.length = 0;
        this._binding.target = null;
        this._binding.frame = null;
    }

    private _addRenderableDirect(renderGroup: RenderGroup, instructionSet: InstructionSet): void
    {
        this._renderer.renderPipes.batch.break(instructionSet);

        if (renderGroup._batchableRenderGroup)
        {
            BigPool.return(renderGroup._batchableRenderGroup);
            renderGroup._batchableRenderGroup = null;
        }

        instructionSet.add(renderGroup);
    }

    private _addRenderableCacheAsTexture(renderGroup: RenderGroup, instructionSet: InstructionSet): void
    {
        const batchableRenderGroup = renderGroup._batchableRenderGroup ??= BigPool.get(BatchableSprite);

        batchableRenderGroup.renderable = renderGroup.root;
        batchableRenderGroup.transform = renderGroup.root.relativeGroupTransform;
        batchableRenderGroup.texture = renderGroup.texture;
        batchableRenderGroup.bounds = renderGroup._textureBounds;

        instructionSet.add(renderGroup);

        this._renderer.renderPipes.blendMode.pushBlendMode(renderGroup, renderGroup.root.groupBlendMode, instructionSet);
        this._renderer.renderPipes.batch.addToBatch(batchableRenderGroup, instructionSet);
        this._renderer.renderPipes.blendMode.popBlendMode(instructionSet);
    }

    /** Draws every stale cache texture `renderGroup` composites, innermost first, ahead of the pass that composites them. */
    public renderCacheTextures(renderGroup: RenderGroup): void
    {
        const stale = this._stale;
        const renderTarget = this._renderer.renderTarget;

        stale.length = 0;
        this._gatherStale(renderGroup.instructionSet, stale);

        if (!stale.length) return;

        renderTarget.push(this._bindingFor(stale[0]));
        this._draw(stale[0]);

        // each cache takes the place of the one before, so the run rebinds the root target only once
        for (let i = 1; i < stale.length; i++)
        {
            renderTarget.replace(this._bindingFor(stale[i]));
            this._draw(stale[i]);
        }

        renderTarget.pop();
    }

    // Execute skips an unrenderable group and only composites a clean cache, so neither is gathered.
    private _gatherStale(instructionSet: InstructionSet, stale: RenderGroup[]): void
    {
        const { instructions, instructionSize } = instructionSet;

        for (let i = 0; i < instructionSize; i++)
        {
            const child = instructions[i] as RenderGroup;

            if (child.renderPipeId !== 'renderGroup' || !child.isRenderable
                || (child.isCachedAsTexture && !child.textureNeedsUpdate)) continue;

            this._gatherStale(child.instructionSet, stale);

            if (child.isCachedAsTexture) stale.push(child);
        }
    }

    private _executeCacheAsTexture(renderGroup: RenderGroup): void
    {
        if (renderGroup.textureNeedsUpdate)
        {
            this._renderer.renderTarget.push(this._bindingFor(renderGroup));
            this._draw(renderGroup);
            this._renderer.renderTarget.pop();
        }

        const sprite = renderGroup._batchableRenderGroup;

        if (sprite._batcher.updateElement(sprite, true))
        {
            sprite._batcher.geometry.buffers[0].update();
        }
    }

    private _bindingFor(renderGroup: RenderGroup): BindOptions
    {
        const binding = this._binding;

        binding.target = renderGroup.texture;
        binding.frame = renderGroup.texture.frame;

        return binding;
    }

    // Draws a cache's instructions into its bound texture, from the root's local space.
    private _draw(renderGroup: RenderGroup): void
    {
        const renderer = this._renderer;

        renderGroup.textureNeedsUpdate = false;

        renderer.globalUniforms.push({
            worldTransformMatrix: renderGroup.textureTransform,
            worldColor: 0xFFFFFFFF,
            offset: this._origin,
        });

        executeInstructions(renderGroup, renderer.renderPipes);

        renderer.renderTarget.finishRenderPass();
        renderer.globalUniforms.pop();
    }

    private _executeDirect(renderGroup: RenderGroup): void
    {
        this._renderer.globalUniforms.push({
            worldTransformMatrix: renderGroup.inverseParentTextureTransform,
            worldColor: renderGroup.parentTextureColorAlpha,
        });

        executeInstructions(renderGroup, this._renderer.renderPipes);

        this._renderer.globalUniforms.pop();
    }
}

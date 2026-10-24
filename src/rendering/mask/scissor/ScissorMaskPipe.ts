import { ExtensionType } from '../../../extensions/Extensions';
import { Matrix } from '../../../maths/matrix/Matrix';
import { Rectangle } from '../../../maths/shapes/Rectangle';
import { Bounds } from '../../../scene/container/bounds/Bounds';
import { StencilMaskPipe } from '../stencil/StencilMaskPipe';

import type { Container } from '../../../scene/container/Container';
import type { Effect } from '../../../scene/container/Effect';
import type { GpuRenderTarget } from '../../renderers/gpu/renderTarget/GpuRenderTarget';
import type { WebGPURenderer } from '../../renderers/gpu/WebGPURenderer';
import type { Instruction } from '../../renderers/shared/instructions/Instruction';
import type { InstructionSet } from '../../renderers/shared/instructions/InstructionSet';
import type { InstructionPipe } from '../../renderers/shared/instructions/RenderPipe';
import type { Renderable } from '../../renderers/shared/Renderable';
import type { RenderPipes } from '../../renderers/types';
import type { StencilMask } from '../stencil/StencilMask';
import type { StencilMaskInstruction } from '../stencil/StencilMaskTypes';

// Vertices snap to this many steps per pixel before the rasterizer decides which pixels a triangle covers.
const SUBPIXELS = 256;
// How far a rectangle's edge may lean across its length, in pixels, and still rasterize as an axis-aligned edge.
const TILT = 0.5 / SUBPIXELS;

// The first pixel centred at or past `position`: where a left or top edge starts covering, or a right or bottom one stops.
function pixelEdge(position: number): number
{
    return Math.ceil((Math.round(position * SUBPIXELS) / SUBPIXELS) - 0.5);
}

// Whether `position` snaps onto a pixel boundary, so every sample of a pixel falls on the same side of the edge.
function onPixelBoundary(position: number): boolean
{
    return Math.round(position * SUBPIXELS) % SUBPIXELS === 0;
}

/** A mask's push or pop in an instruction set; both carry its clip, so the pop undoes what the push chose. */
interface MaskClipInstruction extends Instruction
{
    renderPipeId: 'stencilMask';
    action: 'pushMask' | 'popMask';
    clip: MaskClip;
}

/** How a mask clips its content, applied where the mask is pushed and restored where it is popped. */
interface ClipMode
{
    apply(clip: MaskClip): void;
    restore(clip: MaskClip): void;
}

/** One mask as its instructions carry it: the stencil steps it falls back to and the scissor it keeps. @internal */
class MaskClip
{
    public readonly effect: StencilMask;
    public readonly pushInstruction: MaskClipInstruction;
    public readonly popInstruction: MaskClipInstruction;
    /** the mask's own draws, which only the stencil path replays */
    public readonly draws: Instruction[] = [];
    public readonly popBegin: StencilMaskInstruction;
    public readonly popEnd: StencilMaskInstruction;
    /** the pixels the scissor keeps, and the clip it replaced on the target */
    public readonly rect = new Rectangle();
    public previous: Rectangle | null = null;
    public pushBegin: StencilMaskInstruction;
    public pushEnd: StencilMaskInstruction;
    public inverse = false;
    public mode: ClipMode;

    constructor(effect: StencilMask)
    {
        this.effect = effect;
        this.pushInstruction = { renderPipeId: 'stencilMask', action: 'pushMask', clip: this, canBundle: false };
        this.popInstruction = { renderPipeId: 'stencilMask', action: 'popMask', clip: this, canBundle: false };
        this.popBegin = {
            renderPipeId: 'stencilMask', action: 'popMaskBegin', mask: effect, inverse: false, canBundle: false,
        };
        this.popEnd = { renderPipeId: 'stencilMask', action: 'popMaskEnd', mask: effect, inverse: false, canBundle: false };
    }

    // Lifts the stencil steps built from `start` out of the set, leaving their place to this clip's push.
    public take(instructionSet: InstructionSet, start: number, inverse: boolean): void
    {
        const instructions = instructionSet.instructions;
        const end = instructionSet.instructionSize - 1;

        this.pushBegin = instructions[start] as StencilMaskInstruction;
        this.pushEnd = instructions[end] as StencilMaskInstruction;
        this.draws.length = 0;

        for (let i = start + 1; i < end; i++)
        {
            this.draws.push(instructions[i]);
        }

        instructionSet.instructionSize = start;
        this.inverse = inverse;
        this.popBegin.inverse = inverse;
    }
}

/** Draws the mask into the stencil around its content, exactly as StencilMaskPipe does. @internal */
class StencilClip implements ClipMode
{
    private readonly _renderer: WebGPURenderer;
    private readonly _stencil: StencilMaskPipe;

    constructor(renderer: WebGPURenderer, stencil: StencilMaskPipe)
    {
        this._renderer = renderer;
        this._stencil = stencil;
    }

    public apply(clip: MaskClip): void
    {
        this._replay(clip.pushBegin, clip.draws, clip.pushEnd);
    }

    public restore(clip: MaskClip): void
    {
        this._replay(clip.popBegin, clip.draws, clip.popEnd);
    }

    private _replay(begin: StencilMaskInstruction, draws: Instruction[], end: StencilMaskInstruction): void
    {
        const pipes = this._renderer.renderPipes;

        this._stencil.execute(begin);

        for (let i = 0; i < draws.length; i++)
        {
            const draw = draws[i];

            (pipes[draw.renderPipeId as keyof RenderPipes] as InstructionPipe<Instruction>).execute(draw);
        }

        this._stencil.execute(end);
    }
}

/** Clips a mask's content with the scissor, inside whatever the target already clips to. @internal */
class ScissorClip implements ClipMode
{
    private readonly _renderer: WebGPURenderer;
    private readonly _pixels = new Matrix();
    private readonly _viewport = new Matrix();
    private readonly _bounds = new Bounds();
    private readonly _whole = new Rectangle();

    constructor(renderer: WebGPURenderer)
    {
        this._renderer = renderer;
    }

    // Whether a scissor keeps exactly the pixels the mask's stencil would on the bound target; `clip.rect` then holds them.
    public covers(clip: MaskClip): boolean
    {
        if (clip.inverse) return false;

        // a mask that draws nothing hides all of its content
        if (!clip.draws.length)
        {
            const outer = this._outer();

            clip.rect.set(outer.x, outer.y, 0, 0);

            return true;
        }

        const rectangle = clip.effect.rectangle;

        if (!rectangle || this._renderer._roundPixels) return false;

        const pixels = this._toPixels(clip.effect.mask.groupTransform);
        const { a, b, c, d } = pixels;
        const { width, height } = rectangle;

        // a quarter turn swaps the edges; any other turn or skew leaves them slanted
        if (!(Math.abs(b * width) <= TILT && Math.abs(c * height) <= TILT)
            && !(Math.abs(a * width) <= TILT && Math.abs(d * height) <= TILT)) return false;

        const bounds = this._bounds;
        const outer = this._outer();

        bounds.clear();
        bounds.addRect(rectangle, pixels);

        // a multisampled stencil keeps the samples a mask covers, which whole pixels match only on pixel boundaries
        if (this._target().msaa && !(onPixelBoundary(bounds.minX) && onPixelBoundary(bounds.minY)
            && onPixelBoundary(bounds.maxX) && onPixelBoundary(bounds.maxY))) return false;

        const left = Math.min(Math.max(pixelEdge(bounds.minX), outer.x), outer.right);
        const top = Math.min(Math.max(pixelEdge(bounds.minY), outer.y), outer.bottom);
        const right = Math.min(Math.max(pixelEdge(bounds.maxX), left), outer.right);
        const bottom = Math.min(Math.max(pixelEdge(bounds.maxY), top), outer.bottom);

        clip.rect.set(left, top, right - left, bottom - top);

        return true;
    }

    public apply(clip: MaskClip): void
    {
        const target = this._target();

        clip.previous = target.scissor;
        target.scissor = clip.rect;
        this._renderer.encoder.setScissorRect(clip.rect);
    }

    public restore(clip: MaskClip): void
    {
        const target = this._target();

        target.scissor = clip.previous;
        this._renderer.encoder.setScissorRect(clip.previous ?? this._wholeTarget());
    }

    private _target(): GpuRenderTarget
    {
        const renderTarget = this._renderer.renderTarget;

        return renderTarget.getGpuRenderTarget(renderTarget.renderTarget);
    }

    private _outer(): Rectangle
    {
        return this._target().scissor ?? this._wholeTarget();
    }

    // What a pass on the bound subresource clips to before any mask does.
    private _wholeTarget(): Rectangle
    {
        const { renderTarget, mipLevel } = this._renderer.renderTarget;
        const width = Math.max(renderTarget.pixelWidth >> mipLevel, 1);
        const height = Math.max(renderTarget.pixelHeight >> mipLevel, 1);

        return this._whole.set(0, 0, width, height);
    }

    // Mask space to target pixels: the matrices the vertex shader applies, then the viewport.
    private _toPixels(groupTransform: Matrix): Matrix
    {
        const { worldTransformMatrix, offset, projectionMatrix } = this._renderer.globalUniforms.globalUniformData;
        const viewport = this._renderer.renderTarget.viewport;
        const halfWidth = viewport.width / 2;
        const halfHeight = viewport.height / 2;

        return this._pixels.copyFrom(groupTransform)
            .prepend(worldTransformMatrix)
            .translate(-offset.x, -offset.y)
            .prepend(projectionMatrix)
            .prepend(this._viewport.set(halfWidth, 0, 0, -halfHeight, viewport.x + halfWidth, viewport.y + halfHeight));
    }
}

/** WebGPU's stencil mask pipe: a scissor where the mask is one axis-aligned rectangle, else the stencil. @internal */
export class ScissorMaskPipe implements InstructionPipe<Instruction>
{
    public static extension = {
        type: [
            ExtensionType.WebGPUPipes,
        ],
        name: 'stencilMask',
    } as const;

    private _renderer: WebGPURenderer;
    private _stencil: StencilMaskPipe;
    private _scissorClip: ScissorClip;
    private _stencilClip: StencilClip;
    private _clips = new WeakMap<StencilMask, MaskClip>();

    constructor(renderer: WebGPURenderer)
    {
        this._renderer = renderer;
        this._stencil = new StencilMaskPipe(renderer);
        this._scissorClip = new ScissorClip(renderer);
        this._stencilClip = new StencilClip(renderer, this._stencil);
    }

    public push(mask: Effect, container: Container, instructionSet: InstructionSet): void
    {
        const clip = this._clip(mask as StencilMask);

        this._closeContent(clip, instructionSet);

        const start = instructionSet.instructionSize;

        this._stencil.push(mask, container, instructionSet);
        clip.take(instructionSet, start, container._maskOptions.inverse);
        instructionSet.add(clip.pushInstruction);
    }

    public pop(mask: Effect, _container: Container, instructionSet: InstructionSet): void
    {
        const clip = this._clip(mask as StencilMask);

        this._closeContent(clip, instructionSet);
        instructionSet.add(clip.popInstruction);
    }

    public execute(instruction: Instruction): void
    {
        const { action, clip } = instruction as MaskClipInstruction;

        if (action === 'popMask')
        {
            clip.mode.restore(clip);

            return;
        }

        clip.mode = this._scissorClip.covers(clip) ? this._scissorClip : this._stencilClip;
        clip.mode.apply(clip);
    }

    public destroy(): void
    {
        this._stencil.destroy();
        this._stencil = null;
        this._scissorClip = null;
        this._stencilClip = null;
        this._clips = null;
        this._renderer = null;
    }

    private _clip(effect: StencilMask): MaskClip
    {
        let clip = this._clips.get(effect);

        if (!clip)
        {
            clip = new MaskClip(effect);
            this._clips.set(effect, clip);
        }

        return clip;
    }

    // Content ahead of the mask closes its batch and blend first, as StencilMaskPipe's push and pop do.
    private _closeContent(clip: MaskClip, instructionSet: InstructionSet): void
    {
        const pipes = this._renderer.renderPipes;

        pipes.batch.break(instructionSet);
        pipes.blendMode.setBlendMode(clip.effect.mask as Renderable, 'none', instructionSet);
    }
}

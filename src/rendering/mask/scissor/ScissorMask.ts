import { ExtensionType } from '../../../extensions/Extensions';
import { Graphics } from '../../../scene/graphics/shared/Graphics';
import { StencilMask } from '../stencil/StencilMask';

import type { ExtensionMetadata } from '../../../extensions/Extensions';
import type { Rectangle } from '../../../maths/shapes/Rectangle';

/** A Graphics stencil mask, which WebGPU scissors while it is one axis-aligned rectangle. @category rendering @advanced */
export class ScissorMask extends StencilMask
{
    /** Tested ahead of StencilMask, which takes every container. */
    public static override extension: ExtensionMetadata = {
        type: ExtensionType.MaskEffect,
        name: 'scissorMask',
        priority: 0,
    };

    public override get rectangle(): Rectangle | null
    {
        const mask = this.mask as Graphics;

        // children, effects, an own render group and snapped vertices all change what the stencil path draws
        if (mask.children.length || mask.effects.length || mask.renderGroup || mask.roundPixels) return null;

        return mask.context.fillRectangle;
    }

    public static override test(mask: any): boolean
    {
        return mask instanceof Graphics;
    }
}

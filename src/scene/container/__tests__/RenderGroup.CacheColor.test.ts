import { Container } from '../Container';
import { RenderGroupPipe } from '../RenderGroupPipe';
import { RenderGroupSystem } from '../RenderGroupSystem';
import { updateRenderGroupTransforms } from '../utils/updateRenderGroupTransforms';
import { DummyView } from './DummyView';

import type { Renderer } from '~/rendering';

const alphaOf = (colorAlpha: number) => (colorAlpha >>> 24) & 0xff;

// A stage holding a translucent, tinted layer cached as texture, with a direct render group inside it.
function cachedLayer(cached: boolean)
{
    const layer = new Container({ label: 'layer', alpha: 0.5, tint: 0xff0000 });
    const inner = new Container({ label: 'inner', alpha: 0.8, isRenderGroup: true });

    inner.addChild(new DummyView({ label: 'view' }));
    layer.addChild(inner);

    if (cached) layer.cacheAsTexture(true);
    else layer.enableRenderGroup();

    const stage = new Container({ label: 'stage', isRenderGroup: true });

    stage.addChild(layer);
    updateRenderGroupTransforms(stage.renderGroup, true);

    const system = new RenderGroupSystem({ view: { resolution: 1, antialias: false } } as unknown as Renderer);

    system['_updateCachedRenderGroups'](stage.renderGroup, null);

    return inner.renderGroup;
}

describe('RenderGroup color inside a cached texture', () =>
{
    it('should leave the cached parent\'s alpha and tint to the texture that draws them', () =>
    {
        const inner = cachedLayer(true);

        expect(alphaOf(inner.worldColorAlpha)).toBe((0.4 * 255) | 0);
        expect(alphaOf(inner.parentTextureColorAlpha)).toBe((0.8 * 255) | 0);
        expect(inner.parentTextureColorAlpha & 0xffffff).toBe(0xffffff);
    });

    it('should keep the world color when no parent is cached', () =>
    {
        const inner = cachedLayer(false);

        expect(inner.parentTextureColorAlpha).toBe(inner.worldColorAlpha);
        expect(alphaOf(inner.parentTextureColorAlpha)).toBe((0.4 * 255) | 0);
    });

    it('should draw a direct group into its parent\'s texture with the relative color', () =>
    {
        const inner = cachedLayer(true);
        const push = jest.fn();
        const renderer = { globalUniforms: { push, pop: jest.fn() }, renderPipes: {} } as unknown as Renderer;
        const pipe = new RenderGroupPipe(renderer);

        pipe['_executeDirect'](inner);

        expect(push).toHaveBeenCalledWith(expect.objectContaining({ worldColor: inner.parentTextureColorAlpha }));
        expect(inner.parentTextureColorAlpha).not.toBe(inner.worldColorAlpha);
    });
});

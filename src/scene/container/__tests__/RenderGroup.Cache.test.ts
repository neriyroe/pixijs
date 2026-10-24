import { Container } from '../Container';
import { RenderGroupSystem } from '../RenderGroupSystem';
import { DummyView } from './DummyView';

import type { Renderer } from '~/rendering';

function prepare(system: RenderGroupSystem, container: Container): void
{
    system['_updateCachedRenderGroups'](container.renderGroup, null);
}

function cachedLayer()
{
    const container = new Container({ label: 'layer' });

    container.addChild(new DummyView({ label: 'view' }));
    container.cacheAsTexture(true);

    const system = new RenderGroupSystem({ view: { resolution: 1, antialias: false } } as unknown as Renderer);

    prepare(system, container);
    container.renderGroup.textureNeedsUpdate = false;

    return { container, group: container.renderGroup, system, getLocalBounds: jest.spyOn(container, 'getLocalBounds') };
}

// A cached layer holding a cached child, both measured and drawn.
function nestedLayer()
{
    const layer = cachedLayer();
    const child = new Container({ label: 'child' });

    child.addChild(new DummyView({ label: 'inner' }));
    child.cacheAsTexture(true);
    layer.container.addChild(child);
    layer.group.updateCacheTexture();
    prepare(layer.system, layer.container);
    layer.group.textureNeedsUpdate = false;
    child.renderGroup.textureNeedsUpdate = false;

    return { ...layer, child: child.renderGroup };
}

describe('RenderGroup cache texture', () =>
{
    it('should repaint into the measured texture and bounds without measuring again', async () =>
    {
        const { container, group, system, getLocalBounds } = cachedLayer();
        const texture = group.texture;
        const bounds = group._textureBounds.clone();

        group.repaintCacheTexture();
        prepare(system, container);

        expect(group.textureNeedsUpdate).toBe(true);
        expect(getLocalBounds).not.toHaveBeenCalled();
        expect(group.texture).toBe(texture);
        expect(group._textureBounds).toMatchObject({ minX: bounds.minX, minY: bounds.minY, maxX: 100, maxY: 100 });
    });

    it('should measure after an update even when a repaint follows it', async () =>
    {
        const { container, group, system, getLocalBounds } = cachedLayer();

        group.updateCacheTexture();
        group.repaintCacheTexture();
        prepare(system, container);

        expect(getLocalBounds).toHaveBeenCalledTimes(1);

        group.repaintCacheTexture();
        prepare(system, container);

        expect(getLocalBounds).toHaveBeenCalledTimes(1);
    });

    it('should repaint a cached parent for a repainted child and measure it for a measured one', async () =>
    {
        const { group, child } = nestedLayer();

        child.repaintCacheTexture();

        expect(group.textureNeedsUpdate).toBe(true);
        expect(group.textureNeedsMeasure).toBe(false);

        child.updateCacheTexture();

        expect(group.textureNeedsMeasure).toBe(true);
    });

    it('should draw a cached parent again for a measured child while the parent holds an undrawn measure', async () =>
    {
        const { group, child } = nestedLayer();

        // A measure asked for after the cache pass outlives the draw, which clears only the update flag.
        group.updateCacheTexture();
        group.textureNeedsUpdate = false;

        child.updateCacheTexture();

        expect(group.textureNeedsUpdate).toBe(true);
        expect(group.textureNeedsMeasure).toBe(true);
    });
});

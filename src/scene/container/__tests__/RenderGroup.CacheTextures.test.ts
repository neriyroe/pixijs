import { describeLocalOnly, getWebGLRenderer, getWebGPURenderer } from '@test-utils';
import { RenderTexture, Texture } from '~/rendering';
import { Container, Sprite } from '~/scene';

import type { BindOptions, RenderTarget, WebGLRenderer, WebGPURenderer } from '~/rendering';

const TINTS = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0x00ffff];

function square(tint: number, x: number): Sprite
{
    const sprite = new Sprite(Texture.WHITE);

    sprite.setSize(8, 8);
    sprite.tint = tint;
    sprite.x = x;

    return sprite;
}

function cached(...children: Container[]): Container
{
    const layer = new Container();

    layer.addChild(...children);
    layer.cacheAsTexture(true);

    return layer;
}

// Plain squares with two cached squares between them, left to right, each 10 pixels apart.
function row()
{
    const first = cached(square(TINTS[1], 10));
    const second = cached(square(TINTS[3], 30));
    const scene = new Container();

    scene.addChild(square(TINTS[0], 0), first, square(TINTS[2], 20), second, square(TINTS[4], 40));

    return { scene, first, second };
}

// The colours along the first row at each of `columns`.
function coloursAt(renderer: WebGLRenderer | WebGPURenderer, texture: RenderTexture, columns: number[]): number[]
{
    const { pixels } = renderer.extract.pixels(texture);
    const colours: number[] = [];

    for (const x of columns)
    {
        colours.push((pixels[x * 4] << 16) | (pixels[(x * 4) + 1] << 8) | pixels[(x * 4) + 2]);
    }

    return colours;
}

describe('RenderGroup cache textures', () =>
{
    let renderer: WebGLRenderer;

    beforeEach(async () =>
    {
        renderer = await getWebGLRenderer();
    });

    afterEach(() =>
    {
        jest.restoreAllMocks();
        renderer.destroy();
    });

    it('should bind the root again only once after a run of stale caches', () =>
    {
        const target = RenderTexture.create({ width: 48, height: 8 });
        const { scene, first, second } = row();
        const system = renderer.renderTarget;
        const bind = system.bind.bind(system) as (options: BindOptions) => RenderTarget;
        const bound: unknown[] = [];

        // the options object is the caller's to reuse, so each target is read as it is bound
        jest.spyOn(system, 'bind').mockImplementation(((options: BindOptions) =>
        {
            bound.push(options.target);

            return bind(options);
        }) as typeof system.bind);

        renderer.render({ container: scene, target });

        const names = new Map<unknown, string>([
            [target, 'root'], [first.renderGroup.texture, 'first'], [second.renderGroup.texture, 'second'],
        ]);

        expect(bound.map((surface) => names.get(surface) ?? 'other')).toEqual(['root', 'first', 'second', 'root']);
        expect(coloursAt(renderer, target, [4, 14, 24, 34, 44])).toEqual(TINTS);

        scene.destroy({ children: true });
        target.destroy(true);
    });

    it('should leave a cache unrenderable or inside a clean cache stale, as executing the root does', () =>
    {
        const target = RenderTexture.create({ width: 48, height: 8 });
        const inner = cached(square(TINTS[0], 0));
        const outer = cached(inner);
        const faded = cached(square(TINTS[1], 20));
        const scene = new Container();

        scene.addChild(outer, faded);
        renderer.render({ container: scene, target });

        inner.renderGroup.textureNeedsUpdate = true;
        faded.alpha = 0;
        faded.updateCacheTexture();
        renderer.render({ container: scene, target });

        expect(outer.renderGroup.textureNeedsUpdate).toBe(false);
        expect(inner.renderGroup.textureNeedsUpdate).toBe(true);
        expect(faded.renderGroup.textureNeedsUpdate).toBe(true);

        scene.destroy({ children: true });
        target.destroy(true);
    });
});

describeLocalOnly('RenderGroup cache textures (WebGPU)', () =>
{
    let renderer: WebGPURenderer;

    // one device for the suite, as every case draws its own scene into its own target
    beforeAll(async () =>
    {
        renderer = await getWebGPURenderer();
    });

    afterEach(() =>
    {
        jest.restoreAllMocks();
    });

    afterAll(() =>
    {
        renderer.destroy();
    });

    // The textures each begun pass drew into, named by `names`.
    function passes(begin: jest.SpyInstance, names: Map<RenderTexture | Texture, string>): string[]
    {
        const byTarget = new Map(Array.from(names, ([texture, name]) =>
            [renderer.renderTarget.getGpuRenderTarget(renderer.renderTarget.getRenderTarget(texture)), name]));

        return begin.mock.calls.map(([gpuRenderTarget]) => byTarget.get(gpuRenderTarget) ?? 'other');
    }

    it('should draw stale cache textures before the pass that composites them, so it never splits', () =>
    {
        // a root that only loads begins at its first draw, so K stale caches cost K + 1 passes; a clear runs at once
        for (const clear of [false, true])
        {
            const target = RenderTexture.create({ width: 48, height: 8 });
            const { scene, first, second } = row();
            const begin = jest.spyOn(renderer.encoder, 'beginRenderPass');
            const cleared = clear ? ['root'] : [];

            renderer.render({ container: scene, target, clear });

            const names = new Map<RenderTexture | Texture, string>([
                [target, 'root'], [first.renderGroup.texture, 'first'], [second.renderGroup.texture, 'second'],
            ]);

            expect(passes(begin, names)).toEqual([...cleared, 'first', 'second', 'root']);
            expect(coloursAt(renderer, target, [4, 14, 24, 34, 44])).toEqual(TINTS);

            begin.mockClear();
            renderer.render({ container: scene, target, clear });
            expect(passes(begin, names)).toEqual(['root']);

            begin.mockClear();
            second.updateCacheTexture();
            renderer.render({ container: scene, target, clear });
            expect(passes(begin, names)).toEqual([...cleared, 'second', 'root']);
            expect(coloursAt(renderer, target, [4, 14, 24, 34, 44])).toEqual(TINTS);

            begin.mockRestore();
            scene.destroy({ children: true });
            target.destroy(true);
        }
    });

    it('should draw a nested cache before the cache that composites it', () =>
    {
        const target = RenderTexture.create({ width: 48, height: 8 });
        const inner = cached(square(TINTS[2], 12));
        const outer = cached(square(TINTS[0], 0), inner);
        const scene = new Container();
        const begin = jest.spyOn(renderer.encoder, 'beginRenderPass');

        scene.addChild(outer);
        renderer.render({ container: scene, target, clear: false });

        const names = new Map<RenderTexture | Texture, string>([
            [target, 'root'], [outer.renderGroup.texture, 'outer'], [inner.renderGroup.texture, 'inner'],
        ]);

        expect(passes(begin, names)).toEqual(['inner', 'outer', 'root']);
        expect(coloursAt(renderer, target, [4, 16])).toEqual([TINTS[0], TINTS[2]]);

        scene.destroy({ children: true });
        target.destroy(true);
    });
});

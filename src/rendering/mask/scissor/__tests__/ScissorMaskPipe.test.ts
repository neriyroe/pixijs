import { describeLocalOnly, getWebGPURenderer } from '@test-utils';
import { AlphaFilter } from '~/filters';
import { Rectangle } from '~/maths';
import { RenderTexture, ScissorMask, STENCIL_MODES, StencilMask, Texture } from '~/rendering';
import { Container, Graphics, Sprite } from '~/scene';

import type { WebGPURenderer } from '~/rendering';

const SIZE = 48;

type Shape = 'rect' | 'poly' | 'circle';

// A rect is scissored; the polygon of the same corners, or a circle, goes through the stencil.
function maskOf(shape: Shape, area: Rectangle): Graphics
{
    const { x, y, right, bottom } = area;
    const graphics = new Graphics();

    if (shape === 'rect') return graphics.rect(x, y, area.width, area.height).fill(0xffffff);
    if (shape === 'poly') return graphics.poly([x, y, right, y, right, bottom, x, bottom]).fill(0xffffff);

    const radius = Math.min(area.width, area.height) / 2;

    return graphics.circle(x + (area.width / 2), y + (area.height / 2), radius).fill(0xffffff);
}

// A red sprite reaching past the target under any placement, masked by `shape`, both inside `holder`.
function masked(shape: Shape, area: Rectangle, holder = new Container()): Container
{
    const content = new Sprite(Texture.WHITE);
    const mask = maskOf(shape, area);

    content.setSize(SIZE * 4, SIZE * 4);
    content.position.set(-SIZE * 2, -SIZE * 2);
    content.tint = 0xff0000;
    content.mask = mask;
    holder.addChild(content, mask);

    return holder;
}

interface TargetOptions
{
    resolution?: number;
    antialias?: boolean;
    clear?: boolean;
}

// Draws `scene` into a fresh target; one bound without a clear only loads, so its pass begins at the first draw.
function render(renderer: WebGPURenderer, scene: Container, options: TargetOptions = {}): Uint8ClampedArray
{
    const { resolution = 1, antialias = false, clear = true } = options;
    const texture = RenderTexture.create({ width: SIZE, height: SIZE, resolution, antialias });

    renderer.render({ container: scene, target: texture, clear });

    const { pixels } = renderer.extract.pixels(texture);

    texture.destroy(true);
    scene.destroy({ children: true });

    return pixels;
}

// The pixel indices where two readbacks differ, for a readable failure.
function differences(a: Uint8ClampedArray, b: Uint8ClampedArray): number[]
{
    const found: number[] = [];

    for (let i = 0; i < a.length; i += 4)
    {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) found.push(i / 4);
    }

    return found;
}

describeLocalOnly('ScissorMaskPipe (WebGPU)', () =>
{
    let renderer: WebGPURenderer;

    // one device for the suite, as every case draws into its own fresh targets
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

    function maskAdds(): jest.SpyInstance
    {
        return jest.spyOn(renderer.stencil, 'setStencilMode');
    }

    function stenciled(spy: jest.SpyInstance): boolean
    {
        return spy.mock.calls.some(([mode]) => mode === STENCIL_MODES.RENDERING_MASK_ADD);
    }

    it('should choose a scissor mask for a Graphics and a stencil mask for any other container', () =>
    {
        const content = new Sprite(Texture.WHITE);
        const graphics = new Graphics().rect(1, 2, 3, 4).fill(0xffffff);
        const container = new Container();

        content.mask = graphics;
        expect(content._maskEffect).toBeInstanceOf(ScissorMask);
        expect((content._maskEffect as ScissorMask).rectangle).toMatchObject({ x: 1, y: 2, width: 3, height: 4 });

        graphics.clear().circle(4, 4, 4).fill(0xffffff);
        expect((content._maskEffect as ScissorMask).rectangle).toBeNull();

        content.mask = container;
        expect(content._maskEffect).toBeInstanceOf(StencilMask);
        expect(content._maskEffect).not.toBeInstanceOf(ScissorMask);
        expect((content._maskEffect as StencilMask).rectangle).toBeNull();

        content.destroy();
        graphics.destroy();
        container.destroy();
    });

    it('should clip a rectangle with the scissor and give the target no stencil', () =>
    {
        const texture = RenderTexture.create({ width: 32, height: 32 });
        const scene = masked('rect', new Rectangle(0, 0, 16, 32));
        const stencil = maskAdds();
        const scissor = jest.spyOn(renderer.encoder, 'setScissorRect');

        renderer.render({ container: scene, target: texture });

        expect(stenciled(stencil)).toBe(false);
        expect(scissor.mock.calls.map(([rect]) => [rect.x, rect.y, rect.width, rect.height]))
            .toEqual([[0, 0, 16, 32], [0, 0, 32, 32]]);
        expect(renderer.renderTarget.getRenderTarget(texture).stencil).toBe(false);

        const { pixels, width } = renderer.extract.pixels(texture);

        expect(Array.from(pixels.slice(((16 * width) + 8) * 4, ((16 * width) + 9) * 4))).toEqual([255, 0, 0, 255]);
        expect(pixels[(((16 * width) + 24) * 4) + 3]).toBe(0);

        scene.destroy({ children: true });
        texture.destroy(true);
    });

    it('should keep the pixels the stencil keeps at fractional edges, turns, flips and resolutions', () =>
    {
        const areas = [
            new Rectangle(4, 6, 20, 14), new Rectangle(2.5, 3.5, 17.25, 9.75), new Rectangle(1.2, 0.5, 30.3, 21.6),
        ];
        const placements: Array<(holder: Container) => void> = [
            () => undefined,
            (holder) =>
            {
                holder.position.set(3.25, 5.5);
            },
            (holder) =>
            {
                holder.scale.set(1.37, 0.81);
            },
            (holder) =>
            {
                holder.scale.set(-1, 1.25);
                holder.x = SIZE - 0.5;
            },
            (holder) =>
            {
                holder.rotation = Math.PI / 2;
                holder.position.set(SIZE - 1.75, 2.25);
            },
            (holder) =>
            {
                holder.rotation = Math.PI;
                holder.position.set(SIZE - 3.5, SIZE - 0.25);
            },
        ];

        for (const resolution of [1, 1.5, 2])
        {
            for (const area of areas)
            {
                for (let index = 0; index < placements.length; index++)
                {
                    const rect = new Container();
                    const poly = new Container();

                    placements[index](rect);
                    placements[index](poly);

                    const stencil = maskAdds();
                    const scissored = render(renderer, masked('rect', area, rect), { resolution });

                    expect(stenciled(stencil)).toBe(false);
                    stencil.mockRestore();

                    const expected = render(renderer, masked('poly', area, poly), { resolution });
                    const corners = [area.x, area.y, area.width, area.height];

                    expect({ resolution, corners, index, differ: differences(scissored, expected) })
                        .toEqual({ resolution, corners, index, differ: [] });
                }
            }
        }
    });

    it('should fall back to the stencil under a rotated ancestor', () =>
    {
        const area = new Rectangle(6, 4, 24, 18);
        const tilted = (): Container =>
        {
            const parent = new Container();

            parent.position.set(20, 8);
            parent.rotation = 0.3;

            return parent;
        };
        const stencil = maskAdds();
        const parent = tilted();

        parent.addChild(masked('rect', area));

        const actual = render(renderer, parent);

        expect(stenciled(stencil)).toBe(true);

        const expectedParent = tilted();

        expectedParent.addChild(masked('poly', area));

        expect(differences(actual, render(renderer, expectedParent))).toEqual([]);
    });

    it('should intersect nested masks, scissored or stenciled either way round', () =>
    {
        const nested = (outer: Shape, inner: Shape): Container =>
        {
            const scene = new Container();
            const group = masked(inner, new Rectangle(10, 2, 30, 40));
            const outerMask = maskOf(outer, new Rectangle(4, 8, 24, 30));

            group.mask = outerMask;
            scene.addChild(group, outerMask);

            return scene;
        };

        const reference = render(renderer, nested('poly', 'poly'));

        expect(differences(render(renderer, nested('rect', 'rect')), reference)).toEqual([]);
        expect(differences(render(renderer, nested('rect', 'poly')), reference)).toEqual([]);
        expect(differences(render(renderer, nested('poly', 'rect')), reference)).toEqual([]);

        const roundedInside = render(renderer, nested('poly', 'circle'));

        expect(differences(render(renderer, nested('rect', 'circle')), roundedInside)).toEqual([]);

        const roundedOutside = render(renderer, nested('circle', 'poly'));

        expect(differences(render(renderer, nested('circle', 'rect')), roundedOutside)).toEqual([]);
    });

    it('should keep its clip across a filter inside the masked content', () =>
    {
        const filtered = (shape: Shape): Container =>
        {
            const holder = masked(shape, new Rectangle(5, 7, 21, 19));

            holder.children[0].filters = [new AlphaFilter({ alpha: 0.5 })];

            return holder;
        };

        expect(differences(render(renderer, filtered('rect')), render(renderer, filtered('poly')))).toEqual([]);
    });

    it('should clip a mask inside a cached layer in that layer\'s texture space', () =>
    {
        const layered = (shape: Shape): Container =>
        {
            const scene = new Container();
            const layer = masked(shape, new Rectangle(3.5, 2, 19, 23));

            layer.position.set(6.25, 4.75);
            layer.cacheAsTexture(true);
            scene.addChild(layer);

            return scene;
        };

        const atTwo = { resolution: 2 };

        expect(differences(render(renderer, layered('rect'), atTwo), render(renderer, layered('poly'), atTwo))).toEqual([]);
    });

    it('should leave a multisampled edge to the stencil unless it lies on a pixel boundary', () =>
    {
        const fractional = new Rectangle(2.5, 3.25, 17.5, 9.75);
        const multisampled = { antialias: true };

        for (const area of [fractional, new Rectangle(4, 6, 20, 14)])
        {
            const stencil = maskAdds();
            const actual = render(renderer, masked('rect', area), multisampled);

            expect(stenciled(stencil)).toBe(area === fractional);
            stencil.mockRestore();

            const expected = render(renderer, masked('poly', area), multisampled);
            const partial = expected.some((value, i) => (i % 4 === 3) && value > 0 && value < 255);

            // the stencil keeps the samples inside a fractional edge, so those pixels come out part covered
            expect({ area: area.x, partial, differ: differences(actual, expected) })
                .toEqual({ area: area.x, partial: area === fractional, differ: [] });
        }
    });

    it('should clip the same in a target that loads, whose pass waits for its first draw', () =>
    {
        const area = new Rectangle(2.5, 3.5, 17.25, 9.75);
        const layered = (): Container =>
        {
            const scene = new Container();
            const layer = masked('rect', area);

            layer.position.set(6.25, 4.75);
            layer.cacheAsTexture(true);
            scene.addChild(layer);

            return scene;
        };
        const scenes: Array<() => Container> = [() => masked('rect', area), () => masked('poly', area), layered];
        const loads = { clear: false };

        for (let index = 0; index < scenes.length; index++)
        {
            const differ = differences(render(renderer, scenes[index](), loads), render(renderer, scenes[index]()));

            expect({ index, differ }).toEqual({ index, differ: [] });
        }
    });

    it('should stencil an inverse mask and hide everything a hidden mask covers, as the stencil does', () =>
    {
        const inverse = (shape: Shape): Container =>
        {
            const holder = masked(shape, new Rectangle(8, 8, 20, 20));
            const content = holder.children[0];

            content.setMask({ mask: content.mask as Graphics, inverse: true });

            return holder;
        };
        const stencil = maskAdds();
        const inverted = render(renderer, inverse('rect'));

        expect(stenciled(stencil)).toBe(true);
        expect(differences(inverted, render(renderer, inverse('poly')))).toEqual([]);

        const hidden = (shape: Shape): Container =>
        {
            const holder = masked(shape, new Rectangle(8, 8, 20, 20));

            holder.children[1].visible = false;

            return holder;
        };

        expect(differences(render(renderer, hidden('rect')), render(renderer, hidden('poly')))).toEqual([]);
    });
});

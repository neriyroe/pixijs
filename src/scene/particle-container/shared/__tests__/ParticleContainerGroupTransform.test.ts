import { ParticleContainer } from '../ParticleContainer';
import { ParticleContainerPipe } from '../ParticleContainerPipe';
import { Matrix, Rectangle } from '~/maths';
import { Texture } from '~/rendering';
import { Container, Particle } from '~/scene';
import { updateRenderGroupTransforms } from '~/scene/container/utils/updateRenderGroupTransforms';

import type { Renderer } from '~/rendering';

// Particles 10px into a group standing at (100, 50), executed under the world transform a pass binds for that group,
// into a frame of `viewport` pixels bound on a pooled 1024 x 512 source.
function executed(worldTransformMatrix: Matrix, viewport = new Rectangle(0, 0, 64, 64))
{
    const particles = new ParticleContainer({ texture: Texture.WHITE, x: 10, y: 10 });
    const holder = new Container({ isRenderGroup: true, x: 100, y: 50 });
    const stage = new Container({ isRenderGroup: true });

    particles.addParticle(new Particle({ texture: Texture.WHITE }));
    holder.addChild(particles);
    stage.addChild(holder);
    updateRenderGroupTransforms(stage.renderGroup, true);

    const renderer = {
        uid: 1,
        _roundPixels: 0,
        gc: { addResourceHash: jest.fn(), now: 0 },
        renderTarget: { viewport },
        globalUniforms: {
            globalUniformData: {
                projectionMatrix: new Matrix(),
                worldTransformMatrix,
                offset: { x: 0, y: 0 },
                worldColor: 0xFFFFFFFF,
                resolution: [1024, 512],
            },
        },
    } as unknown as Renderer;
    const pipe = new ParticleContainerPipe(renderer, { execute: jest.fn() });

    pipe.execute(particles);

    return pipe.localUniforms.uniforms;
}

describe('ParticleContainer transform', () =>
{
    it('should draw in its render group\'s space inside a group cached as texture', () =>
    {
        const matrix = executed(new Matrix().translate(-4, -2)).uTranslationMatrix;

        expect(matrix.tx).toBeCloseTo(6);
        expect(matrix.ty).toBeCloseTo(8);
    });

    it('should land where it stands when its group draws straight to the screen', () =>
    {
        const matrix = executed(new Matrix().translate(100, 50)).uTranslationMatrix;

        expect(matrix.tx).toBeCloseTo(110);
        expect(matrix.ty).toBeCloseTo(60);
    });

    it('should round on the pixels of the bound frame rather than the whole pooled source', () =>
    {
        expect(executed(new Matrix(), new Rectangle(0, 0, 660, 400)).uResolution).toEqual([660, 400]);
    });
});

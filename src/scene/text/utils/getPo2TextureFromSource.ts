import { type ImageLike } from '../../../environment/ImageLike';
import { TexturePool } from '../../../rendering/renderers/shared/texture/TexturePool';

import type { ICanvas } from '../../../environment/canvas/ICanvas';
import type { SCALE_MODE } from '../../../rendering/renderers/shared/texture/const';
import type { Texture } from '../../../rendering/renderers/shared/texture/Texture';

/**
 * Takes an image and creates a texture from it, using an upload-only texture from the texture pool sized to the
 * image's top left `width` by `height` pixels. Remember to return the texture when you don't need it any more!
 * @param image - The image to create a texture from
 * @param width - the frame width of the texture, in pixels from the image's left edge
 * @param height - the frame height of the texture, in pixels from the image's top edge
 * @param resolution - The resolution of the texture
 * @param autoGenerateMipmaps - Whether to generate mipmaps for the texture
 * @param scaleMode - The scale mode of the texture
 * @returns - The texture
 * @internal
 */
export function getPo2TextureFromSource(
    image: ImageLike | HTMLCanvasElement | ICanvas,
    width: number,
    height: number,
    resolution: number,
    autoGenerateMipmaps = false,
    scaleMode?: SCALE_MODE
): Texture
{
    const texture = TexturePool.getOptimalTexture({
        width: width / resolution,
        height: height / resolution,
        resolution,
        autoGenerateMipmaps,
        scaleMode,
        renderTarget: false,
    });

    texture.source.uploadMethodId = 'image';
    texture.source.resource = image;
    texture.source.alphaMode = 'premultiply-alpha-on-upload';

    // We want to update the resource on the GPU,
    // but we do not want to resize the texture.
    // calling `texture.source.update` will fit the resource to the texture
    // causing a resize of the texture on the GPU.
    // which is not what we want!
    texture.source.emit('update', texture.source);

    return texture;
}

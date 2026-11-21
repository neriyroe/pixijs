import type { CubeTextureSource } from '../../../shared/texture/sources/CubeTextureSource';
import type { GPU } from '../../GpuDeviceSystem';
import type { GpuTextureUploader } from './GpuTextureUploader';

const FACE_ORDER: (keyof CubeTextureSource['faces'])[] = ['right', 'left', 'top', 'bottom', 'front', 'back'];

/**
 * Creates a cube uploader that delegates to the given uploader registry.
 * @param uploaders - Uploader registry keyed by `uploadMethodId` (must include `image`).
 * @internal
 */
export function createGpuUploadCubeTextureResource(
    uploaders: Record<string, GpuTextureUploader> & { image: GpuTextureUploader }
): GpuTextureUploader<CubeTextureSource>
{
    const faceUploader = (face: CubeTextureSource['faces'][keyof CubeTextureSource['faces']]) =>
        uploaders[face.uploadMethodId] || uploaders.image;

    return {
        type: 'cube',
        needsRenderAttachment(source: CubeTextureSource)
        {
            return FACE_ORDER.some((key) =>
                !!faceUploader(source.faces[key]).needsRenderAttachment?.(source.faces[key]));
        },
        upload(source: CubeTextureSource, gpuTexture: GPUTexture, gpu: GPU)
        {
            const faces = source.faces;

            for (let i = 0; i < FACE_ORDER.length; i++)
            {
                const key = FACE_ORDER[i];
                const face = faces[key];

                faceUploader(face).upload(face as any, gpuTexture, gpu, i);
            }
        }
    };
}


import { BindGroup } from '../../renderers/gpu/shader/BindGroup';
import { Texture } from '../../renderers/shared/texture/Texture';

import type { BindResource } from '../../renderers/gpu/shader/BindResource';
import type { TEXTURE_FORMATS } from '../../renderers/shared/texture/const';
import type { TextureSource } from '../../renderers/shared/texture/sources/TextureSource';

const cachedGroups: Record<number, BindGroup> = {};

/** A cached batch releases all bindings when any of its textures is destroyed. */
class TextureBatchBindGroup extends BindGroup
{
    constructor(resources: Record<string, BindResource>, private readonly cacheKey: number)
    {
        super(resources);
    }

    protected override onResourceChange(resource: BindResource): void
    {
        if (resource.destroyed)
            this.destroy();
        else
            super.onResourceChange(resource);
    }

    public override destroy(): void
    {
        if (cachedGroups[this.cacheKey] === this) delete cachedGroups[this.cacheKey];

        super.destroy();
    }
}

/**
 * Releases cached texture bindings before the matching render-target pool is retired.
 * @param format - The texture format whose cached bindings are no longer used.
 * @internal
 */
export function clearTextureBatchBindGroups(format: TEXTURE_FORMATS): void
{
    for (const key in cachedGroups)
    {
        const group = cachedGroups[key];

        if (!group.resources)
        {
            delete cachedGroups[key];
            continue;
        }

        for (const index in group.resources)
        {
            const resource = group.resources[index];

            if (resource && (resource._resourceType !== 'textureSource' || (resource as TextureSource).format !== format))
                continue;

            group.destroy();
            delete cachedGroups[key];
            break;
        }
    }
}

/**
 * @param textures
 * @param size
 * @param maxTextures
 * @internal
 */
export function getTextureBatchBindGroup(textures: TextureSource[], size: number, maxTextures: number)
{
    let uid = 2166136261; // FNV-1a 32-bit offset basis

    for (let i = 0; i < size; i++)
    {
        uid ^= textures[i].uid;
        uid = Math.imul(uid, 16777619);
        uid >>>= 0;
    }

    return cachedGroups[uid] || generateTextureBatchBindGroup(textures, size, uid, maxTextures);
}

function generateTextureBatchBindGroup(textures: TextureSource[], size: number, key: number, maxTextures: number): BindGroup
{
    const bindGroupResources: Record<string, any> = {};

    let bindIndex = 0;

    for (let i = 0; i < maxTextures; i++)
    {
        const texture = i < size ? textures[i] : Texture.EMPTY.source;

        bindGroupResources[bindIndex++] = texture.source;
        bindGroupResources[bindIndex++] = texture.style;
    }

    // pad out with empty textures
    const bindGroup = new TextureBatchBindGroup(bindGroupResources, key);

    cachedGroups[key] = bindGroup;

    return bindGroup;
}
